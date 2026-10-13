#!/usr/bin/env python3
"""Olive staging deployment script (port of scripts/deploy-staging.ts)."""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
import time
import urllib.request
from datetime import UTC, datetime

context = os.environ.get("OLIVE_STAGING_DOCKER_CONTEXT") or "dolphin"
ssh_host = os.environ.get("OLIVE_STAGING_SSH_HOST") or context
staging_url = (os.environ.get("OLIVE_STAGING_URL") or "http://192.168.0.2:4470").rstrip("/")
container_name = os.environ.get("OLIVE_STAGING_CONTAINER_NAME") or "olive"
service_name = os.environ.get("OLIVE_STAGING_SERVICE_NAME") or "olive"
image_name = os.environ.get("OLIVE_STAGING_IMAGE_NAME") or "olive"
image_retention = int(os.environ.get("OLIVE_STAGING_IMAGE_RETAIN") or "3")
health_timeout = int(os.environ.get("OLIVE_STAGING_HEALTH_TIMEOUT") or "60")
target_platform = os.environ.get("OLIVE_STAGING_TARGET_PLATFORM") or "linux/amd64"

now_dt = datetime.now(tz=UTC)
build_date = now_dt.isoformat().replace("+00:00", "Z")
timestamp = now_dt.strftime("%Y%m%d-%H%M%S")
new_tag = f"{image_name}:staging-{timestamp}"
latest_tag = f"{image_name}:staging-latest"


def run_cmd(
    cmd: list[str],
    *,
    fatal: bool = True,
    stream: bool = False,
) -> tuple[bool, str, str]:
    proc = subprocess.run(
        cmd,
        text=True,
        capture_output=not stream,
        check=False,
    )
    ok = proc.returncode == 0
    stdout = (proc.stdout or "").strip() if not stream else ""
    stderr = (proc.stderr or "").strip() if not stream else ""
    if not ok and fatal:
        if stderr:
            print(stderr, file=sys.stderr)
        print(f"\nCommand failed: {' '.join(cmd)}", file=sys.stderr)
        sys.exit(1)
    return ok, stdout, stderr


def docker(args: list[str], *, fatal: bool = True, stream: bool = False) -> tuple[bool, str, str]:
    return run_cmd(["docker", "--context", context, *args], fatal=fatal, stream=stream)


def main() -> None:
    print("🫒 Olive staging deploy")
    print(f"  Context: {context}")
    print(f"  SSH host: {ssh_host}")
    print(f"  URL: {staging_url}")
    print(f"  Container: {container_name}")
    print(f"  New image: {new_tag}")

    ok, out, _ = docker(["inspect", "--format", "{{json .}}", container_name], fatal=False)
    if not ok or not out:
        print(f"\nCannot deploy without an existing Compose-managed {container_name} container.", file=sys.stderr)
        sys.exit(1)

    container = json.loads(out)
    cfg = container.get("Config") or {}
    labels = cfg.get("Labels") or {}
    prev_image = cfg.get("Image")
    prev_image_id = container.get("Image")
    compose_dir = labels.get("com.docker.compose.project.working_dir")
    compose_project = labels.get("com.docker.compose.project")

    if not prev_image or not prev_image_id or not compose_dir or not compose_project:
        print(f"\nCould not read Compose metadata for {container_name}.", file=sys.stderr)
        sys.exit(1)

    tags_to_apply = ["-t", new_tag, "-t", latest_tag]
    if prev_image not in (new_tag, latest_tag):
        tags_to_apply.extend(["-t", prev_image])

    print("\n🔨 Building image on staging Docker context...")
    docker(
        [
            "build",
            "--platform",
            target_platform,
            "--build-arg",
            "APP_VERSION=0.2.0",
            "--build-arg",
            f"BUILD_DATE={build_date}",
            *tags_to_apply,
            ".",
        ],
        stream=True,
    )

    print(f"\n🚀 Recreating {container_name} through Compose on {ssh_host}...")
    run_cmd(
        [
            "ssh",
            ssh_host,
            f"cd {shlex.quote(compose_dir)} && docker compose --project-name {shlex.quote(compose_project)} up --detach --force-recreate {shlex.quote(service_name)}",
        ]
    )

    ok_upd, upd_out, _ = docker(["inspect", "--format", "{{.Image}}", container_name], fatal=False)
    if not ok_upd or not upd_out or upd_out == prev_image_id:
        print("\n⚠️ Deploy did not replace the running image.", file=sys.stderr)
        sys.exit(1)

    print(f"\n⏳ Waiting for health check ({staging_url}/api/health)...")
    healthy = False
    for elapsed in range(1, health_timeout + 1):
        time.sleep(1.0)
        try:
            with urllib.request.urlopen(f"{staging_url}/api/health", timeout=4.0) as resp:
                if resp.status == 200 and json.load(resp).get("status") == "ok":
                    healthy = True
                    print(f"  ✅ Healthy after {elapsed}s.")
                    break
        except Exception:
            ok_ssh, ssh_out, _ = run_cmd(
                ["ssh", ssh_host, "curl -s -f http://localhost:4470/api/health"],
                fatal=False,
            )
            if ok_ssh and '"status":"ok"' in ssh_out:
                healthy = True
                print(f"  ✅ Healthy via internal host after {elapsed}s.")
                break

    if not healthy:
        print("\n❌ Health check failed. Recent container logs:", file=sys.stderr)
        docker(["logs", "--tail", "50", container_name], fatal=False)
        sys.exit(1)

    ok_imgs, imgs_out, _ = docker(["images", image_name, "--format", "{{.Tag}}"], fatal=False)
    if ok_imgs:
        stale = [
            t
            for t in imgs_out.splitlines()
            if t.startswith("staging-") and t != "staging-latest"
        ][image_retention:]
        for tag in stale:
            docker(["rmi", f"{image_name}:{tag}"], fatal=False)

    print(f"\n✨ Staging deploy complete: {new_tag}")


if __name__ == "__main__":
    main()
