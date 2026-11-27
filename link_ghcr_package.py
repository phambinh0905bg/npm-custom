#!/usr/bin/env python3
"""Link the GHCR package to the GitHub repo, via the OCI source annotation.

GitHub shows a repository link on a container package when the manifest carries
`org.opencontainers.image.source`, and it uses that link to offer "inherit
visibility from the repository". The annotation has to be added to the manifest
that is already on the registry, so this rewrites the tag in place rather than
rebuilding anything.

Usage: python3 link_ghcr_package.py
"""
import json
import os
import urllib.request

BASE = os.environ.get("PORTAINER_API_URL", "http://192.168.1.250:9000")
TOKEN = os.environ["PORTAINER_TOKEN"]
DOCKER = f"{BASE}/api/endpoints/{os.environ.get('PORTAINER_ENDPOINT_ID', '3')}/docker"

GH_USER = os.environ.get("GH_USER", "phambinh0905bg")
REPO_URL = os.environ.get("REPO_URL", f"https://github.com/{GH_USER}/npm-custom")
IMAGE = os.environ.get("IMAGE", f"ghcr.io/{GH_USER}/npm-custom")
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


def run(cmd, env=None, timeout=1800, name="ghcr-link"):
    try:
        api("DELETE", f"/containers/{name}?force=true", timeout=60)
    except Exception:
        pass
    body = {
        "Image": "docker:cli",
        "Entrypoint": ["/bin/sh", "-lc", cmd],
        "Env": env or [],
        "HostConfig": {
            "Binds": ["/var/run/docker.sock:/var/run/docker.sock"],
            "NetworkMode": "host",
        },
    }
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
    api("DELETE", f"/containers/{cid}?force=true", timeout=120)
    return "".join(out), res.get("StatusCode")


def main():
    # Copy each tag onto itself with the source annotation added. imagetools
    # rewrites the manifest in the registry, so no rebuild of the 2 GB image.
    cmds = [
        'printf %s "$GHCR_TOKEN" | docker login ghcr.io -u '
        + GH_USER
        + " --password-stdin >/dev/null 2>&1 || { echo LOGIN_FAILED; exit 3; }",
        "echo LOGIN_OK",
    ]
    for tag in TAGS:
        cmds.append(
            f'docker buildx imagetools create -t {IMAGE}:{tag} '
            f'--annotation "index:org.opencontainers.image.source={REPO_URL}" '
            f'--annotation "index:org.opencontainers.image.description=Nginx Proxy Manager 2.17.1 with per-domain access logs and bulk SSL apply" '
            f"{IMAGE}:{tag} 2>&1 | tail -2"
        )
    out, rc = run("; ".join(cmds), env=[f"GHCR_TOKEN={GH_TOKEN}"], timeout=900)
    print(out.strip()[-2000:])
    if rc != 0 or "LOGIN_FAILED" in out:
        raise SystemExit(f"link failed (rc={rc})")


if __name__ == "__main__":
    main()
