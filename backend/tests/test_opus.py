"""Raw Plaud Opus detection and Ogg Opus wrapping tests."""

from __future__ import annotations

import struct
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from olive.app import create_app
from olive.db import create_db
from olive.layout import meeting_paths
from olive.ml.opus import PACKET_BYTES, TOC_BYTE, is_raw_plaud_opus, wrap_raw_opus_bytes


def _raw_opus(packets: int = 120) -> bytes:
    return b"".join(bytes([TOC_BYTE]) + bytes([i % 251]) * (PACKET_BYTES - 1) for i in range(packets))


def _parse_pages(data: bytes) -> list[dict]:
    pages = []
    offset = 0
    while offset < len(data):
        assert data[offset : offset + 4] == b"OggS"
        flags = data[offset + 5]
        granule, serial, sequence = struct.unpack_from("<QII", data, offset + 6)
        crc_stored = struct.unpack_from("<I", data, offset + 22)[0]
        n_segments = data[offset + 26]
        lacing = data[offset + 27 : offset + 27 + n_segments]
        payload_len = sum(lacing)
        page_len = 27 + n_segments + payload_len
        page = bytearray(data[offset : offset + page_len])
        page[22:26] = b"\x00\x00\x00\x00"
        from olive.ml.opus import _ogg_crc

        assert _ogg_crc(bytes(page)) == crc_stored, "ogg page CRC must validate"
        pages.append(
            {
                "flags": flags,
                "granule": granule,
                "sequence": sequence,
                "payload": bytes(data[offset + 27 + n_segments : offset + page_len]),
            }
        )
        offset += page_len
    return pages


def test_detects_fixed_size_toc_packets() -> None:
    assert is_raw_plaud_opus(_raw_opus()) is True


def test_rejects_normal_containers_and_bad_layouts() -> None:
    assert is_raw_plaud_opus(b"OggS" + bytes(10000)) is False
    assert is_raw_plaud_opus(b"ID3" + bytes(10000)) is False
    assert is_raw_plaud_opus(_raw_opus(10)) is False  # too short
    bad = bytearray(_raw_opus())
    bad[3 * PACKET_BYTES] = 0x00  # one packet without the TOC byte
    assert is_raw_plaud_opus(bytes(bad)) is False
    assert is_raw_plaud_opus(_raw_opus() + b"x") is False  # not a packet multiple


def test_rejects_wrapping_non_raw_data() -> None:
    with pytest.raises(ValueError, match="unsupported headerless Opus"):
        wrap_raw_opus_bytes(b"OggS" + bytes(10000))


def test_audio_route_serves_wrapped_ogg_for_raw_opus(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    now = 1_700_000_000_000
    meeting_id = "m-opus-1"
    paths = meeting_paths(meetings_dir, now, "Opus Meeting", meeting_id)
    Path(paths.audio_dir).mkdir(parents=True, exist_ok=True)
    (Path(paths.folder) / "audio/rec.opus").write_bytes(_raw_opus())
    with handle.engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO meetings (id, title, start_time, end_time, source, status, tags,
                  primary_transcript_artifact_id, primary_summary_artifact_id, last_error, created_at, updated_at)
                VALUES (:id, 'Opus Meeting', :now, :end, 'plaud', 'ready', '[]', NULL, NULL, NULL, :now, :now)
                """
            ),
            {"id": meeting_id, "now": now, "end": now + 5000},
        )
        conn.execute(
            text(
                """
                INSERT INTO recordings (id, meeting_id, path, mime, duration_ms, size_bytes, sha256,
                  provider, provider_recording_id, created_at)
                VALUES ('rec-opus', :mid, 'audio/rec.opus', 'audio/opus', 2400, 9600, 'sha-opus', 'plaud', NULL, :now)
                """
            ),
            {"mid": meeting_id, "now": now},
        )
    app = create_app({"db": handle.engine, "meetingsDir": meetings_dir})
    client = TestClient(app)

    # App startup migrated the stored file in place to valid Ogg Opus.
    assert (Path(paths.folder) / "audio/rec.opus").read_bytes()[:4] == b"OggS"

    res = client.get(f"/api/meetings/{meeting_id}/audio")
    assert res.status_code == 200
    assert res.headers["content-type"] == "audio/opus"
    assert res.content[:4] == b"OggS"

    range_res = client.get(f"/api/meetings/{meeting_id}/audio", headers={"range": "bytes=0-9"})
    assert range_res.status_code == 206
    assert range_res.content == res.content[:10]
    handle.engine.dispose()


async def test_ingest_stores_raw_opus_wrapped(tmp_path: Path) -> None:
    from olive.services.ingest import IngestService

    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    service = IngestService(db=handle.engine, meetings_dir=meetings_dir, now=lambda: 1_700_000_000_000)
    result = await service.ingest_audio(
        {
            "audioBytes": _raw_opus(),
            "filename": "plaud.opus",
            "mime": "audio/opus",
            "title": "Raw Opus Upload",
        }
    )
    stored = Path(meetings_dir).rglob("*.opus")
    files = list(stored)
    assert len(files) == 1
    assert files[0].read_bytes()[:4] == b"OggS"
    assert result["meetingId"]
    handle.engine.dispose()


def test_wraps_into_valid_ogg_opus() -> None:
    raw = _raw_opus(120)
    wrapped = wrap_raw_opus_bytes(raw)
    pages = _parse_pages(wrapped)

    assert pages[0]["flags"] & 0x02  # BOS
    assert pages[0]["payload"].startswith(b"OpusHead")
    assert pages[1]["payload"].startswith(b"OpusTags")
    assert pages[-1]["flags"] & 0x04  # EOS
    assert pages[-1]["granule"] == 120 * 960

    audio_payload = b"".join(p["payload"] for p in pages[2:])
    assert audio_payload == raw  # packets preserved verbatim, no re-encode
