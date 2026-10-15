"""Vectors-only speaker library export/import tests (issue #3, option 1)."""

from __future__ import annotations

import json
import math
import uuid
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import text

from olive.app import create_app
from olive.db import create_db
from olive.ml import WESPEAKER_MODEL_TAG
from olive.services.speakers import (
    LIBRARY_REDUNDANT_SIMILARITY,
    MAX_ENROLLMENT_CLIPS,
    SPEAKER_LIBRARY_VECTOR_DIM,
    SPEAKER_LIBRARY_VERSION,
    SpeakerService,
)

NOW = 1_700_000_000_000


def _vec(i: int, dim: int = SPEAKER_LIBRARY_VECTOR_DIM) -> list[float]:
    v = [0.0] * dim
    v[i % dim] = 1.0
    return v


def _near_dup(i: int) -> list[float]:
    v = _vec(i)
    v[(i + 1) % SPEAKER_LIBRARY_VECTOR_DIM] = 1e-7
    return v


def _seed_speaker(
    engine,
    speaker_id: str,
    name: str,
    vectors: list[list[float]],
    *,
    enrolled_at: int | None = NOW,
    extra_provider_ids: dict[str, Any] | None = None,
) -> None:
    pids: dict[str, Any] = {**(extra_provider_ids or {})}
    pids["local"] = [json.dumps(v) for v in vectors]
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO speakers (
                  id, name, provider_ids, enrolled_at, enrollment_clip_paths, created_at
                ) VALUES (:id, :name, :pids, :eat, '[]', :now)
                """
            ),
            {"id": speaker_id, "name": name, "pids": json.dumps(pids), "eat": enrolled_at, "now": NOW},
        )


def _service(engine, tmp_path: Path) -> SpeakerService:
    return SpeakerService({"db": engine, "configDir": str(tmp_path / "config"), "now": lambda: NOW})


def _library(speakers: list[dict[str, Any]], **overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "version": SPEAKER_LIBRARY_VERSION,
        "createdAt": NOW,
        "embeddingModel": WESPEAKER_MODEL_TAG,
        "speakers": speakers,
    }
    base.update(overrides)
    return base


def _entry(name: str, vectors: list[list[float]], **overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "name": name,
        "enrolledAt": NOW,
        "createdAt": NOW,
        "voiceprints": vectors,
    }
    base.update(overrides)
    return base


def test_export_round_trip_skips_placeholders_and_unenrolled(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    _seed_speaker(handle.engine, "spk-ada", "Ada", [_vec(0), _vec(1)])
    _seed_speaker(handle.engine, "spk-grace", "Grace", [_vec(2)])
    _seed_speaker(handle.engine, "spk-ghost", "Speaker 1", [_vec(3)])
    _seed_speaker(handle.engine, "spk-new", "Newcomer", [])

    library = _service(handle.engine, tmp_path).export_speaker_library({})

    assert library["version"] == SPEAKER_LIBRARY_VERSION
    assert library["embeddingModel"] == WESPEAKER_MODEL_TAG
    assert [s["name"] for s in library["speakers"]] == ["Ada", "Grace"]
    ada = next(s for s in library["speakers"] if s["name"] == "Ada")
    assert ada["id"] == "spk-ada"
    assert ada["voiceprints"] == [_vec(0), _vec(1)]
    handle.engine.dispose()


def test_export_filters_by_speaker_ids(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    _seed_speaker(handle.engine, "spk-ada", "Ada", [_vec(0)])
    _seed_speaker(handle.engine, "spk-grace", "Grace", [_vec(2)])

    library = _service(handle.engine, tmp_path).export_speaker_library({"speakerIds": ["spk-grace"]})

    assert [s["name"] for s in library["speakers"]] == ["Grace"]
    handle.engine.dispose()


def test_import_merge_creates_merges_and_dedupes(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    _seed_speaker(handle.engine, "spk-ada", "Ada", [_vec(0)])
    service = _service(handle.engine, tmp_path)

    grace_id = str(uuid.uuid4())
    result = service.import_speaker_library(
        {
            "library": _library(
                [
                    _entry("ada", [_vec(0), _near_dup(0), _vec(1)]),
                    _entry("Grace", [_vec(2)], id=grace_id),
                ]
            ),
            "mode": "merge",
        }
    )

    assert result["mode"] == "merge"
    assert result["dryRun"] is False
    assert result["stats"]["created"] == 1
    assert result["stats"]["merged"] == 1
    assert result["stats"]["skipped"] == 0
    # e1 (Ada) + e2 (Grace) stored; e0 exact dup and near-dup skipped.
    assert result["stats"]["vectorsImported"] == 2
    assert result["stats"]["vectorsSkippedRedundant"] == 2
    assert any("no enrollment audio" in w for w in result["warnings"])

    with handle.engine.connect() as conn:
        ada = conn.execute(text("SELECT * FROM speakers WHERE id='spk-ada'")).mappings().one()
        ada_vectors = [json.loads(s) for s in json.loads(ada["provider_ids"])["local"]]
        assert len(ada_vectors) == 2
        grace = conn.execute(text("SELECT * FROM speakers WHERE id=:id"), {"id": grace_id}).mappings().one()
        assert grace["name"] == "Grace"
    # Merged speaker echoes back in camelCase Speaker shape.
    assert {s["name"] for s in result["speakers"]} == {"Ada", "Grace"}
    handle.engine.dispose()


def test_import_is_case_insensitive_on_names(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    _seed_speaker(handle.engine, "spk-ada", "Ada Lovelace", [_vec(0)])
    service = _service(handle.engine, tmp_path)

    result = service.import_speaker_library(
        {"library": _library([_entry("ADA LOVELACE", [_vec(5)])]), "mode": "merge"}
    )

    assert result["stats"] == {
        "speakersImported": 1,
        "created": 0,
        "merged": 1,
        "skipped": 0,
        "vectorsImported": 1,
        "vectorsSkippedRedundant": 0,
    }
    handle.engine.dispose()


def test_import_dry_run_mutates_nothing_and_returns_plan(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    _seed_speaker(handle.engine, "spk-ada", "Ada", [_vec(0)])
    service = _service(handle.engine, tmp_path)

    result = service.import_speaker_library(
        {
            "library": _library([_entry("Ada", [_vec(0)]), _entry("Grace", [_vec(2)])]),
            "mode": "merge",
            "dryRun": True,
        }
    )

    assert result["dryRun"] is True
    assert result["stats"]["created"] == 1
    assert result["stats"]["skipped"] == 1
    assert result["speakers"] == []
    by_name = {p["name"]: p for p in result["plan"]}
    assert by_name["Ada"]["action"] == "skipped"
    assert by_name["Ada"]["vectorsNew"] == 0
    assert by_name["Grace"]["action"] == "created"
    assert by_name["Grace"]["vectorsNew"] == 1
    with handle.engine.connect() as conn:
        count = conn.execute(text("SELECT COUNT(*) FROM speakers")).scalar()
        assert count == 1
    handle.engine.dispose()


def test_import_replace_wipes_and_relinks_meetings_by_name(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    now = NOW
    with handle.engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO meetings (
                  id, title, start_time, end_time, source, status, tags,
                  primary_transcript_artifact_id, primary_summary_artifact_id,
                  last_error, created_at, updated_at
                ) VALUES ('m1', 'Sync', :now, :end, 'upload', 'ready', '[]', NULL, NULL, NULL, :now, :now)
                """
            ),
            {"now": now, "end": now + 60_000},
        )
    _seed_speaker(handle.engine, "spk-ada-old", "Ada", [_vec(0)])
    _seed_speaker(handle.engine, "spk-zed", "Zed", [_vec(9)])
    with handle.engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO meeting_speakers (meeting_id, speaker_id, evidence_artifact_id)"
                " VALUES ('m1', 'spk-ada-old', NULL), ('m1', 'spk-zed', NULL)"
            )
        )
    service = _service(handle.engine, tmp_path)

    result = service.import_speaker_library(
        {
            "library": _library([_entry("Ada", [_vec(4)]), _entry("Grace", [_vec(2)])]),
            "mode": "replace",
        }
    )

    assert result["stats"]["created"] == 2
    assert any("removed 2 existing" in w for w in result["warnings"])
    assert any("meeting attribution" in w for w in result["warnings"])
    with handle.engine.connect() as conn:
        names = sorted(r["name"] for r in conn.execute(text("SELECT name FROM speakers")).mappings().all())
        assert names == ["Ada", "Grace"]
        links = conn.execute(text("SELECT meeting_id, speaker_id FROM meeting_speakers")).mappings().all()
        assert len(links) == 1
        ada_id = conn.execute(text("SELECT id FROM speakers WHERE name='Ada'")).scalar()
        assert links[0]["meeting_id"] == "m1"
        assert links[0]["speaker_id"] == ada_id
    handle.engine.dispose()


def test_import_replace_dry_run_writes_nothing(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    _seed_speaker(handle.engine, "spk-ada", "Ada", [_vec(0)])
    service = _service(handle.engine, tmp_path)

    result = service.import_speaker_library(
        {"library": _library([_entry("Ada", [_vec(4)])]), "mode": "replace", "dryRun": True}
    )

    assert result["dryRun"] is True
    assert any("would remove 1 existing" in w for w in result["warnings"])
    with handle.engine.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM speakers")).scalar() == 1
    handle.engine.dispose()


def test_import_validation_errors(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    service = _service(handle.engine, tmp_path)

    cases = [
        ({"mode": "merge"}, "library object is required"),
        ({"library": "nope", "mode": "merge"}, "library object is required"),
        ({"library": {"version": "9.9", "speakers": []}}, "Unsupported speaker library version"),
        ({"library": {"version": "1.0"}}, "library.speakers must be a list"),
        ({"library": _library([], version="1.0"), "mode": "replace"}, "empty file"),
        ({"library": _library([_entry("", [_vec(0)])])}, "missing a name"),
        ({"library": _library([_entry("Speaker 9", [_vec(0)])])}, "generic speaker label"),
        ({"library": _library([_entry("Ada", [])])}, "no voiceprints"),
        ({"library": _library([_entry("Ada", [[1.0] * 12])])}, "must be a list of 256 numbers"),
        (
            {"library": _library([_entry("Ada", [[math.nan] * SPEAKER_LIBRARY_VECTOR_DIM])])},
            "non-finite",
        ),
        (
            {"library": _library([_entry("Ada", [[math.inf] * SPEAKER_LIBRARY_VECTOR_DIM])])},
            "non-finite",
        ),
        ({"library": _library([_entry("Ada", [_vec(0)])]), "mode": "bogus"}, "merge"),
    ]
    for options, fragment in cases:
        try:
            service.import_speaker_library(options)
        except ValueError as exc:
            assert fragment in str(exc), f"{options} -> {exc}"
        else:
            raise AssertionError(f"expected ValueError for {options}")

    too_many = {"library": _library([_entry(f"P{i}", [_vec(i)]) for i in range(1001)])}
    try:
        service.import_speaker_library(too_many)
    except ValueError as exc:
        assert "max 1000" in str(exc)
    else:
        raise AssertionError("expected speaker cap error")
    handle.engine.dispose()


def test_import_truncates_to_eight_vectors_with_warning(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    service = _service(handle.engine, tmp_path)

    result = service.import_speaker_library(
        {"library": _library([_entry("Ada", [_vec(i) for i in range(10)])]), "mode": "merge"}
    )

    assert result["stats"]["vectorsImported"] == MAX_ENROLLMENT_CLIPS
    assert any("max 8" in w for w in result["warnings"])
    assert result["speakers"][0]["providerIds"]["local"] is not None
    assert len(result["speakers"][0]["providerIds"]["local"]) == MAX_ENROLLMENT_CLIPS
    handle.engine.dispose()


def test_import_id_collision_with_different_name_creates_new_speaker(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    _seed_speaker(handle.engine, "spk-taken", "Ada", [_vec(0)])
    service = _service(handle.engine, tmp_path)

    result = service.import_speaker_library(
        {"library": _library([_entry("Bob", [_vec(7)], id="spk-taken")]), "mode": "merge"}
    )

    assert result["stats"]["created"] == 1
    assert any("already used" in w for w in result["warnings"])
    assert result["speakers"][0]["id"] != "spk-taken"
    with handle.engine.connect() as conn:
        ada = conn.execute(text("SELECT name FROM speakers WHERE id='spk-taken'")).mappings().one()
        assert ada["name"] == "Ada"
    handle.engine.dispose()


def test_import_model_mismatch_warns_but_applies(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    service = _service(handle.engine, tmp_path)

    result = service.import_speaker_library(
        {
            "library": _library([_entry("Ada", [_vec(0)])], embeddingModel="other/model"),
            "mode": "merge",
        }
    )

    assert result["stats"]["created"] == 1
    assert any("embedding model" in w for w in result["warnings"])
    handle.engine.dispose()


def test_http_export_and_import_round_trip(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    _seed_speaker(handle.engine, "spk-ada", "Ada", [_vec(0)])
    app = create_app(
        {
            "db": handle.engine,
            "configDir": str(tmp_path / "config"),
            "meetingsDir": str(tmp_path / "meetings"),
        }
    )
    client = TestClient(app)

    export_res = client.get("/api/speakers/export")
    assert export_res.status_code == 200
    library = export_res.json()["library"]
    assert [s["name"] for s in library["speakers"]] == ["Ada"]

    download_res = client.get("/api/speakers/export?download=1")
    assert download_res.status_code == 200
    assert "attachment" in download_res.headers.get("content-disposition", "")

    # Import onto a fresh instance.
    handle2 = create_db(":memory:")
    app2 = create_app(
        {
            "db": handle2.engine,
            "configDir": str(tmp_path / "config2"),
            "meetingsDir": str(tmp_path / "meetings"),
        }
    )
    client2 = TestClient(app2)
    import_res = client2.post("/api/speakers/import", json={"library": library, "mode": "merge"})
    assert import_res.status_code == 200
    body = import_res.json()
    assert body["stats"]["created"] == 1
    assert body["speakers"][0]["name"] == "Ada"

    bad_res = client2.post("/api/speakers/import", json={"library": {"version": "0.1", "speakers": []}})
    assert bad_res.status_code == 400
    handle.engine.dispose()
    handle2.engine.dispose()


def test_http_import_accepts_raw_library_body(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    app = create_app(
        {
            "db": handle.engine,
            "configDir": str(tmp_path / "config"),
            "meetingsDir": str(tmp_path / "meetings"),
        }
    )
    client = TestClient(app)

    res = client.post("/api/speakers/import", json=_library([_entry("Ada", [_vec(0)])]))
    assert res.status_code == 200
    assert res.json()["stats"]["created"] == 1
    handle.engine.dispose()


def _mcp_call(client: TestClient, name: str, args: dict[str, Any]) -> dict[str, Any]:
    res = client.post(
        "/mcp",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Host": "127.0.0.1",
        },
        json={
            "jsonrpc": "2.0",
            "id": str(uuid.uuid4()),
            "method": "tools/call",
            "params": {"name": name, "arguments": args},
        },
    )
    assert res.status_code == 200
    return res.json()["result"]


def _mcp_text(result: dict[str, Any]) -> Any:
    assert result.get("isError") is not True, result
    return json.loads(result["content"][0]["text"])


def test_mcp_export_is_read_and_import_requires_write_flag(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    _seed_speaker(handle.engine, "spk-ada", "Ada", [_vec(0)])
    app = create_app(
        {
            "db": handle.engine,
            "configDir": str(tmp_path / "config"),
            "meetingsDir": str(tmp_path / "meetings"),
        }
    )
    client = TestClient(app)

    list_res = client.post(
        "/mcp",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Host": "127.0.0.1",
        },
        json={"jsonrpc": "2.0", "id": "1", "method": "tools/list", "params": {}},
    )
    names = [t["name"] for t in list_res.json()["result"]["tools"]]
    assert "export_speaker_library" in names
    assert "import_speaker_library" not in names

    exported = _mcp_text(_mcp_call(client, "export_speaker_library", {}))
    assert [s["name"] for s in exported["library"]["speakers"]] == ["Ada"]

    denied = _mcp_call(client, "import_speaker_library", {"library": exported["library"]})
    assert denied.get("isError") is True
    assert "OLIVE_MCP_WRITE=1" in denied["content"][0]["text"]
    handle.engine.dispose()


def test_mcp_import_dry_run_and_apply_when_enabled(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    _seed_speaker(handle.engine, "spk-ada", "Ada", [_vec(0)])
    app = create_app(
        {
            "db": handle.engine,
            "configDir": str(tmp_path / "config"),
            "meetingsDir": str(tmp_path / "meetings"),
            "mcpWriteEnabled": True,
        }
    )
    client = TestClient(app)
    library = _library([_entry("Ada", [_vec(0), _vec(1)]), _entry("Grace", [_vec(2)])])

    plan = _mcp_text(_mcp_call(client, "import_speaker_library", {"library": library, "dryRun": True}))
    assert plan["operation"] == "import_speaker_library"
    assert plan["dryRun"] is True
    assert plan["stats"]["created"] == 1

    applied = _mcp_text(_mcp_call(client, "import_speaker_library", {"library": library}))
    assert applied["stats"]["created"] == 1
    assert applied["stats"]["merged"] == 1

    bad = _mcp_call(client, "import_speaker_library", {"library": {"version": "0.1"}})
    assert bad.get("isError") is True
    handle.engine.dispose()


def test_redundant_threshold_constant_sanity() -> None:
    assert LIBRARY_REDUNDANT_SIMILARITY > 0.95
