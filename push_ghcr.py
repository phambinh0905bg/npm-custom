#!/usr/bin/env python3
"""Push the custom NPM image from the remote Docker daemon to GHCR.

The image only exists on 192.168.1.250, so the push happens there, through a
throwaway docker:cli container that has the host's docker.sock mounted.

The registry token is passed as a container env var and never on a command line,
and the container is removed immediately after the push so the token does not
linger in a stopped container's Config.Env.
"""
import json
import os
import sys
import urllib.request

BASE = os.environ.get("PORTAINER_API_URL", "http://192.168.1.250:9000")
TOKEN = os.environ["PORTAINER_TOKEN"]
EP = os.environ.get("PORTAINER_ENDPOINT_ID", "3")
DOCKER = f"{BASE}/api/endpoints/{EP}/docker"

SRC = os.environ.get("SRC_IMAGE", "npm-custom:2.17.1-bplus")
GH_USER = os.environ.get("GH_USER", "phambinh0905bg")
GH_REPO = os.environ.get("GH_REPO", f"ghcr.io/{GH_USER}/npm-custom")
TAGS = os.environ.get("PUSH_TAGS", "2.17.1-bplus,latest").split(",")
GH_TOKEN = os.environ["GH_TOKEN_ENV"]


def api(method, path, body=None, timeout=900):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        DOCKER + path,
        data=data,
        method=method,
        headers={"X-API-Key": TOKEN, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None


def remove(name):
    try:
        api("DELETE", f"/containers/{name}?force=true", timeout=120)
    except Exception:
        pass


def run(name, cmd, env=None, timeout=3600):
    body = {
        "Image": "docker:cli",
        "Entrypoint": ["/bin/sh", "-lc", cmd],
        "Env": env or [],
        "HostConfig": {
            "Binds": ["/var/run/docker.sock:/var/run/docker.sock"],
            "NetworkMode": "host",
            "AutoRemove": False,
        },
    }
    remove(name)
    created = api("POST", f"/containers/create?name={name}", body, timeout=120)
    cid = created["Id"]
    api("POST", f"/containers/{cid}/start", timeout=120)
    res = api("POST", f"/containers/{cid}/wait", timeout=timeout)
    req = urllib.request.Request(
        f"{DOCKER}/containers/{cid}/logs?stdout=1&stderr=1",
        headers={"X-API-Key": TOKEN},
    )
    raw = urllib.request.urlopen(req, timeout=300).read()
    out, i = [], 0
    while i + 8 <= len(raw):
        size = int.from_bytes(raw[i + 4 : i + 8], "big")
        out.append(raw[i + 8 : i + 8 + size].decode("utf-8", "replace"))
        i += 8 + size
    if i == 0:
        out.append(raw.decode("utf-8", "replace"))
    text = "".join(out)
    remove(name)
    return text, res.get("StatusCode")


def main():
    print(f"source image: {SRC}")
    print(f"target:       {GH_REPO}")
    print(f"tags:         {', '.join(TAGS)}")

    tag_cmds = " && ".join(f"docker tag {SRC} {GH_REPO}:{t}" for t in TAGS)
    out, rc = run("ghcr-tag", tag_cmds)
    if rc != 0:
        print(out[-2000:])
        raise SystemExit(f"tag failed (rc={rc})")
    print("tagged ok")

    login_push = (
        f'printf %s "$GHCR_TOKEN" | docker login ghcr.io -u {GH_USER} --password-stdin >/dev/null 2>&1 '
        f"|| {{ echo LOGIN_FAILED; exit 3; }}; "
        f"echo LOGIN_OK; "
        + " ; ".join(f"docker push {GH_REPO}:{t} 2>&1 | tail -3" for t in TAGS)
    )
    out, rc = run("ghcr-push", login_push, env=[f"GHCR_TOKEN={GH_TOKEN}"], timeout=3600)
    print(out.strip()[-3000:])
    if rc != 0:
        raise SystemExit(f"push failed (rc={rc})")
    if "LOGIN_FAILED" in out:
        raise SystemExit("registry login failed")


if __name__ == "__main__":
    main()
