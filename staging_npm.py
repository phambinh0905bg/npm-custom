#!/usr/bin/env python3
"""Start (or refresh) a staging container from a COPY of the live NPM data.

Production is never touched: the live /data directory is copied with a throwaway
container, and staging mounts the copy on different ports. Nothing here writes to
/data/nginx-proxy-manager.

Usage:
    python3 staging_npm.py up      # create/refresh staging from a fresh copy
    python3 staging_npm.py down    # remove staging container + copy
    python3 staging_npm.py status
"""
import json
import os
import shutil
import sys
import urllib.request

BASE = os.environ.get("PORTAINER_API_URL", "http://192.168.1.250:9000")
TOKEN = os.environ["PORTAINER_TOKEN"]
EP = os.environ.get("PORTAINER_ENDPOINT_ID", "3")
DOCKER = f"{BASE}/api/endpoints/{EP}/docker"

NAME = "npm-staging"
IMAGE = os.environ.get("STAGING_IMAGE", "npm-custom:test")
SRC_DATA = "/data/nginx-proxy-manager"
STAGE_ROOT = "/data/npm-staging"
NETWORK = "home-network"
PORTS = {"80/tcp": [{"HostIp": "0.0.0.0", "HostPort": "18080"}],
         "443/tcp": [{"HostIp": "0.0.0.0", "HostPort": "18443"}],
         "81/tcp": [{"HostIp": "0.0.0.0", "HostPort": "18181"}]}


def api(method, path, body=None, timeout=300):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        DOCKER + path, data=data, method=method,
        headers={"X-API-Key": TOKEN, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None


def exec_in(container, cmd, timeout=600):
    ex = api("POST", f"/containers/{container}/exec", {
        "AttachStdout": True, "AttachStderr": True, "Tty": False,
        "Cmd": ["/bin/sh", "-lc", cmd], "User": "root",
    }, timeout=60)
    eid = ex["Id"]
    req = urllib.request.Request(
        f"{DOCKER}/exec/{eid}/start",
        data=json.dumps({"Detach": False, "Tty": False}).encode(),
        method="POST",
        headers={"X-API-Key": TOKEN, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    out, i = [], 0
    while i + 8 <= len(raw):
        size = int.from_bytes(raw[i+4:i+8], "big")
        out.append(raw[i+8:i+8+size].decode("utf-8", "replace"))
        i += 8 + size
    if i == 0:
        out.append(raw.decode("utf-8", "replace"))
    return "".join(out)


def container_state(name):
    try:
        info = api("GET", f"/containers/{name}/json", timeout=30)
        return info["State"]["Status"]
    except Exception:
        return None


def remove(name):
    try:
        api("POST", f"/containers/{name}/stop?t=10", timeout=60)
    except Exception:
        pass
    try:
        api("DELETE", f"/containers/{name}?force=true&v=false", timeout=60)
    except Exception:
        pass


def copy_data():
    """Copy the live data directory using a throwaway alpine container.

    Runs as a one-shot container with both directories mounted, so the read and
    the write both happen inside the Docker daemon's own namespace - no large
    transfer through the API.
    """
    print("copying live data -> staging copy ...")
    body = {
        "Image": "alpine:latest",
        "Cmd": ["/bin/sh", "-lc",
                f"rm -rf {STAGE_ROOT}/data {STAGE_ROOT}/letsencrypt && "
                f"mkdir -p {STAGE_ROOT} && "
                f"cp -a {SRC_DATA}/data {STAGE_ROOT}/data && "
                f"cp -a {SRC_DATA}/letsencrypt {STAGE_ROOT}/letsencrypt && "
                f"rm -f {STAGE_ROOT}/data/logs/*.log && "
                f"echo COPIED && du -sh {STAGE_ROOT}"],
        "HostConfig": {
            "Binds": ["/data:/data"],
            "AutoRemove": False,
            "NetworkMode": "none",
        },
    }
    created = api("POST", "/containers/create?name=npm-staging-copy", body, timeout=120)
    cid = created["Id"]
    api("POST", f"/containers/{cid}/start", timeout=120)
    res = api("POST", f"/containers/{cid}/wait", timeout=900)
    out = exec_logs(cid)
    api("DELETE", f"/containers/{cid}?force=true", timeout=120)
    print(out.strip())
    if "COPIED" not in out:
        raise SystemExit("staging data copy failed")
    if res.get("StatusCode") != 0:
        raise SystemExit(f"copy container exited {res.get('StatusCode')}")


def exec_logs(cid):
    req = urllib.request.Request(
        f"{DOCKER}/containers/{cid}/logs?stdout=1&stderr=1",
        headers={"X-API-Key": TOKEN},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        raw = resp.read()
    out, i = [], 0
    while i + 8 <= len(raw):
        size = int.from_bytes(raw[i+4:i+8], "big")
        out.append(raw[i+8:i+8+size].decode("utf-8", "replace"))
        i += 8 + size
    if i == 0:
        out.append(raw.decode("utf-8", "replace"))
    return "".join(out)


def up():
    if container_state(NAME):
        print("removing existing staging container")
        remove(NAME)
    copy_data()

    body = {
        "Image": IMAGE,
        "Env": ["TZ=Asia/Ho_Chi_Minh", "DISABLE_IPV6=true"],
        "ExposedPorts": {k: {} for k in PORTS},
        "HostConfig": {
            "PortBindings": PORTS,
            "Binds": [f"{STAGE_ROOT}/data:/data", f"{STAGE_ROOT}/letsencrypt:/etc/letsencrypt"],
            "RestartPolicy": {"Name": "no"},
        },
        "NetworkingConfig": {"EndpointsConfig": {NETWORK: {"Aliases": [NAME]}}},
    }
    api("POST", f"/containers/create?name={NAME}", body, timeout=120)
    api("POST", f"/containers/{NAME}/start", timeout=180)
    print(f"staging started on 18080/18443/18181 from {IMAGE}")


def down():
    remove(NAME)
    body = {
        "Image": "alpine:latest",
        "Cmd": ["/bin/sh", "-lc", f"rm -rf {STAGE_ROOT}"],
        "HostConfig": {"Binds": ["/data:/data"], "NetworkMode": "none"},
    }
    created = api("POST", "/containers/create?name=npm-staging-clean", body, timeout=60)
    cid = created["Id"]
    api("POST", f"/containers/{cid}/start", timeout=60)
    api("POST", f"/containers/{cid}/wait", timeout=300)
    api("DELETE", f"/containers/{cid}?force=true", timeout=60)
    print("staging removed")


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "status"
    if action == "up":
        up()
    elif action == "down":
        down()
    else:
        print(f"{NAME}: {container_state(NAME)}")
