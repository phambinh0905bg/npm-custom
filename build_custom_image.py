#!/usr/bin/env python3
"""Build the customised nginx-proxy-manager image ON the remote host.

The Docker daemon at 192.168.1.250 is driven through the Portainer API, so the
build context is streamed as a tar instead of shipping a local image (which would
need a 2 GB transfer over the LAN).

The Dockerfile in npm-custom needs `nginxproxymanager/testca`, a stage used only
to bake a self-signed CA into the image for the project's own test suite. That
stage is not published for every platform, so the context ships a Dockerfile
without it and without the CA copy - neither has any effect on runtime.

Usage:
    python3 build_custom_image.py --tag npm-custom:test
"""
import io
import json
import os
import sys
import tarfile
import urllib.parse
import urllib.request
from pathlib import Path

BASE = os.environ.get("PORTAINER_API_URL", "http://192.168.1.250:9000")
TOKEN = os.environ["PORTAINER_TOKEN"]
EP = os.environ.get("PORTAINER_ENDPOINT_ID", "3")
DOCKER = f"{BASE}/api/endpoints/{EP}/docker"

REPO = Path(__file__).resolve().parent

# Dockerfile without the testca stage. Everything else is byte-identical to
# docker/Dockerfile in the repo.
DOCKERFILE = """
ARG BASE_IMAGE=nginxproxymanager/nginx-full:certbot-node
FROM $BASE_IMAGE

ARG TARGETPLATFORM
ARG BUILD_VERSION
ARG BUILD_COMMIT
ARG BUILD_DATE

ENV SUPPRESS_NO_CONFIG_WARNING=1 \\
\tS6_BEHAVIOUR_IF_STAGE2_FAILS=1 \\
\tS6_CMD_WAIT_FOR_SERVICES_MAXTIME=0 \\
\tS6_FIX_ATTRS_HIDDEN=1 \\
\tS6_KILL_FINISH_MAXTIME=10000 \\
\tS6_VERBOSITY=1 \\
\tNODE_ENV=production \\
\tNPM_BUILD_VERSION="${BUILD_VERSION}" \\
\tNPM_BUILD_COMMIT="${BUILD_COMMIT}" \\
\tNPM_BUILD_DATE="${BUILD_DATE}" \\
\tNODE_OPTIONS="--openssl-legacy-provider"

RUN echo "fs.file-max = 65535" > /etc/sysctl.conf \\
\t&& apt-get update \\
\t&& apt-get install -y --no-install-recommends jq logrotate \\
\t&& apt-get clean \\
\t&& rm -rf /var/lib/apt/lists/*

COPY docker/scripts/install-s6 /tmp/install-s6
RUN /tmp/install-s6 "${TARGETPLATFORM}" && rm -f /tmp/install-s6

EXPOSE 80 81 443

COPY backend       /app
COPY frontend/dist /app/frontend
COPY docker/rootfs /

WORKDIR /app
RUN yarn install \\
\t&& yarn cache clean

RUN rm -rf /etc/s6-overlay/s6-rc.d/user/contents.d/frontend /etc/nginx/conf.d/dev.conf \\
\t&& chmod 644 /etc/logrotate.d/nginx-proxy-manager

VOLUME [ "/data" ]
ENTRYPOINT [ "/init" ]

LABEL org.label-schema.schema-version="1.0" \\
\torg.label-schema.license="MIT" \\
\torg.label-schema.name="nginx-proxy-manager" \\
\torg.label-schema.description="Docker container for managing Nginx proxy hosts with a simple, powerful interface" \\
\torg.label-schema.url="https://github.com/jc21/nginx-proxy-manager" \\
\torg.label-schema.vcs-url="https://github.com/jc21/nginx-proxy-manager.git" \\
\torg.label-schema.vendor="BPlus custom build"
"""

SKIP_DIRS = {"node_modules", ".git", "dist", "__pycache__", "test", "docs", ".github", "tests"}


def build_context() -> bytes:
    buf = io.BytesIO()
    count = 0
    with tarfile.open(fileobj=buf, mode="w") as tar:
        def add(path: Path, arcname: str):
            nonlocal count
            info = tar.gettarinfo(str(path), arcname)
            # Normalise ownership: the daemon runs as root and must not inherit
            # the build user's uid/gid into the image.
            info.uid = info.gid = 0
            info.uname = info.gname = "root"
            if path.is_file():
                with open(path, "rb") as fh:
                    tar.addfile(info, fh)
            else:
                tar.addfile(info)
            count += 1

        data = DOCKERFILE.encode()
        info = tarfile.TarInfo("Dockerfile")
        info.size = len(data)
        info.uid = info.gid = 0
        info.uname = info.gname = "root"
        tar.addfile(info, io.BytesIO(data))
        count += 1

        for top in ("backend", "docker/rootfs", "docker/scripts/install-s6"):
            src = REPO / top
            if src.is_file():
                add(src, top)
                continue
            for root, dirs, files in os.walk(src):
                dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
                rel_root = Path(root).relative_to(REPO).as_posix()
                add(Path(root), rel_root)
                for f in files:
                    if f.endswith((".pyc", ".DS_Store")):
                        continue
                    add(Path(root) / f, f"{rel_root}/{f}")

        dist = REPO / "frontend" / "dist"
        if not (dist / "index.html").exists():
            raise SystemExit("frontend/dist is missing - run `yarn build` in frontend/ first")
        for root, dirs, files in os.walk(dist):
            rel_root = Path(root).relative_to(REPO).as_posix()
            add(Path(root), rel_root)
            for f in files:
                add(Path(root) / f, f"{rel_root}/{f}")

    print(f"context: {count} entries, {len(buf.getvalue()) / 1024 / 1024:.1f} MB")
    return buf.getvalue()


def build(tag: str):
    payload = build_context()
    query = f"?t={urllib.parse.quote(tag)}&nocache=false&rm=true"
    req = urllib.request.Request(
        f"{DOCKER}/build{query}",
        data=payload,
        headers={"X-API-Key": TOKEN, "Content-Type": "application/x-tar"},
        method="POST",
    )
    errors = []
    with urllib.request.urlopen(req, timeout=3600) as resp:
        for raw in resp:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                print("  ", line[:200])
                continue
            if "error" in msg:
                errors.append(msg["error"])
                print("ERROR:", msg["error"][:500])
            elif "stream" in msg:
                text = msg["stream"].rstrip()
                if text and not text.startswith((" ---> ", "Step ")):
                    print("  ", text[:200])
    if errors:
        raise SystemExit(f"build failed: {errors[-1][:500]}")
    print(f"built {tag}")


if __name__ == "__main__":
    tag = "npm-custom:test"
    args = sys.argv[1:]
    if "--tag" in args:
        tag = args[args.index("--tag") + 1]
    build(tag)
