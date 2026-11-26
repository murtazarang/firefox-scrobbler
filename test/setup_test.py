"""Linux smoke test for the first-install entry point; no Cloudflare calls."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

REPO = Path(__file__).resolve().parents[1]
MOCK = r'''#!/usr/bin/env python3
import json, os, pathlib, stat, sys
cwd = pathlib.Path.cwd()
with open(os.environ["CALLS"], "a") as fp:
    fp.write(json.dumps({"cwd":str(cwd), "args":sys.argv[1:]})+"\n")
assert os.environ["CLOUDFLARE_API_TOKEN"] == "mock-admin-token"
assert os.environ["CLOUDFLARE_ACCOUNT_ID"] == "a" * 32
assert sys.argv[1:3] == ["--yes","wrangler@latest"]
args = sys.argv[3:]
scenario = os.environ["SCENARIO"]
secrets = ("LASTFM_API_KEY", "LASTFM_SHARED_SECRET", "SESSION_ENCRYPTION_KEY")
uuid = "00000000-0000-4000-8000-000000000001"
if args == ["secret","list","--name","stream-scrobbler","--format","json"]:
    if scenario == "denied":
        raise SystemExit(1)
    print(json.dumps([{"name":x,"type":"secret_text"} for x in secrets] if scenario=="rerun" else []))
elif args == ["d1","list","--json"]:
    print(json.dumps([{"name":"stream-scrobbler","uuid":uuid}] if scenario in {"rerun","lost"} or pathlib.Path("created").exists() else []))
elif args == ["d1","create","stream-scrobbler","--update-config=false"]:
    assert scenario in {"fresh","migration-error"}
    pathlib.Path("created").touch()
elif args == ["d1","migrations","apply","DB","--remote","--force"]:
    assert json.loads(pathlib.Path("wrangler.jsonc").read_text())["d1_databases"][0]["database_id"] == uuid
    assert pathlib.Path("migrations/0001_sessions.sql").exists()
    if scenario == "migration-error":
        raise SystemExit(7)
elif args[:6] == ["d1","execute","DB","--remote","--json","--command"]:
    assert scenario == "lost"
    print('[{"results":[{"has_sessions":1}]}]')
elif args[:2] == ["deploy","--keep-vars"]:
    assert scenario in {"fresh","rerun"}
    if scenario == "fresh":
        import base64
        assert args[2] == "--secrets-file"
        path = pathlib.Path(args[3])
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        values = json.loads(path.read_text())
        assert values["LASTFM_API_KEY"] == "mock-app-key"
        assert values["LASTFM_SHARED_SECRET"] == "mock-app-secret"
        assert len(base64.b64decode(values["SESSION_ENCRYPTION_KEY"],validate=True)) == 32
    else:
        assert len(args) == 2
        assert not pathlib.Path("secrets.json").exists()
else:
    raise AssertionError(args)
'''

def run():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp)
        mock = path / "npx"
        mock.write_text(MOCK)
        mock.chmod(0o700)
        baseline = (REPO / "worker/wrangler.jsonc").read_bytes()
        for scenario, success, last in [
            ("fresh", True, ["deploy", "--keep-vars"]),
            ("rerun", True, ["deploy", "--keep-vars"]),
            ("denied", False, ["secret", "list"]),
            ("cancel", False, ["secret", "list"]),
            ("lost", False, ["d1", "execute"]),
            ("migration-error", False, ["d1", "migrations"]),
        ]:
            calls = path / scenario
            env = dict(os.environ, PATH=f"{path}:{os.environ['PATH']}", CALLS=str(calls), SCENARIO=scenario)
            env.pop("CLOUDFLARE_ACCOUNT_ID", None)
            env.pop("CLOUDFLARE_API_TOKEN", None)
            supplied = "a"*32 + "\nmock-admin-token\n"
            supplied += "no\n" if scenario == "cancel" else "deploy\n"
            if scenario in {"fresh","lost","migration-error"}:
                supplied += "mock-app-key\nmock-app-secret\n"
            result = subprocess.run(
                ["script", "-qE", "never", "-ec", "bash " + shlex.quote(str(REPO / "worker/setup.sh")), "/dev/null"],
                input=supplied, text=True, capture_output=True, env=env, cwd=tmp, timeout=20)
            assert (result.returncode == 0) == success, (scenario,result.stdout,result.stderr)
            output = result.stdout+result.stderr
            assert not any(x in output for x in ("mock-admin-token","mock-app-key","mock-app-secret")), output
            invocations = [json.loads(line) for line in calls.read_text().splitlines()]
            assert invocations[-1]["args"][2:4] == last, invocations
            assert not Path(invocations[-1]["cwd"]).exists(), invocations
            assert b"REPLACE_WITH_D1_DATABASE_ID" in baseline and (REPO / "worker/wrangler.jsonc").read_bytes() == baseline
            print(f"Setup {scenario}: OK")

if __name__ == "__main__":
    run()
