"""Wrap headerless raw Plaud Opus packets into a standard Ogg Opus container.

Plaud's third-party API serves some recordings as a raw stream of fixed-size
80-byte Opus packets (32 kbps CBR, one mono CELT 20 ms frame per packet, TOC
byte 0xB8) with no container header. Nothing off the shelf can decode or even
identify that as audio (ffmpeg rejects it; file-type sniffers misclassify
it), so every Plaud "opus" recording used to fail transcription everywhere.

This module detects that exact layout and muxes the packets into a valid
Ogg Opus stream (RFC 7845) without re-encoding. Layout constants verified
against real Plaud downloads and independently by the localplaud project.
"""

from __future__ import annotations

import hashlib
import struct
from pathlib import Path
from typing import Any

PACKET_BYTES = 80
PACKETS_PER_PAGE = 50
TOC_BYTE = 0xB8  # one mono CELT wideband frame, 20 ms
SAMPLES_PER_PACKET = 960  # Opus granule positions always use 48 kHz
MIN_PACKETS = 50

# Maximum bytes inspected to decide whether data is raw Plaud Opus.
_PROBE_PACKETS = 200


def is_raw_plaud_opus(data: bytes) -> bool:
    """True when ``data`` is a complete stream of fixed 80-byte Opus packets."""
    if len(data) < MIN_PACKETS * PACKET_BYTES or len(data) % PACKET_BYTES:
        return False
    probe = min(len(data) // PACKET_BYTES, _PROBE_PACKETS)
    return all(data[i * PACKET_BYTES] == TOC_BYTE for i in range(probe)) and _all_packets_valid(data)


def _all_packets_valid(data: bytes) -> bool:
    return all(data[i * PACKET_BYTES] == TOC_BYTE for i in range(len(data) // PACKET_BYTES))


def wrap_raw_opus_bytes(data: bytes) -> bytes:
    """Mux validated raw packets into an Ogg Opus byte string."""
    if not is_raw_plaud_opus(data):
        raise ValueError("unsupported headerless Opus packet layout")
    packets = [data[i : i + PACKET_BYTES] for i in range(0, len(data), PACKET_BYTES)]

    out = bytearray()
    out += _ogg_page([_opus_head()], sequence=0, granule=0, flags=0x02)  # BOS
    out += _ogg_page([_opus_tags()], sequence=1, granule=0, flags=0x00)

    sequence = 2
    for offset in range(0, len(packets), PACKETS_PER_PAGE):
        chunk = packets[offset : offset + PACKETS_PER_PAGE]
        final = offset + len(chunk) == len(packets)
        out += _ogg_page(
            chunk,
            sequence=sequence,
            granule=(offset + len(chunk)) * SAMPLES_PER_PACKET,
            flags=0x04 if final else 0x00,  # EOS on the final audio page
        )
        sequence += 1
    return bytes(out)


def migrate_raw_opus_recordings(db: Any, meetings_dir: str) -> int:
    """Rewrite stored raw Plaud Opus recordings in place as Ogg Opus.

    Canonicalizing on disk means every consumer (browser player, ffmpeg,
    cloud ASR, external tools) sees a valid file without any per-exit-point
    wrapping. Idempotent: wrapped files no longer match the raw layout.
    Returns the number of recordings migrated.
    """
    from sqlalchemy import text

    from ..layout import meeting_paths

    with db.connect() as conn:
        rows = (
            conn.execute(
                text(
                    """
                    SELECT r.id AS recording_id, r.path, m.start_time, m.title, m.id AS meeting_id
                    FROM recordings r JOIN meetings m ON m.id = r.meeting_id
                    """
                )
            )
            .mappings()
            .all()
        )

    migrated = 0
    for row in rows:
        folder = meeting_paths(meetings_dir, int(row["start_time"]), row["title"], row["meeting_id"]).folder
        full_path = Path(folder) / row["path"]
        if not full_path.exists():
            continue
        data = full_path.read_bytes()
        if not is_raw_plaud_opus(data):
            continue
        wrapped = wrap_raw_opus_bytes(data)
        tmp_path = full_path.with_name(f"{full_path.name}.wrapping.tmp")
        tmp_path.write_bytes(wrapped)
        tmp_path.replace(full_path)
        with db.begin() as conn:
            conn.execute(
                text("UPDATE recordings SET size_bytes = :sz, sha256 = :sha WHERE id = :id"),
                {
                    "sz": len(wrapped),
                    "sha": hashlib.sha256(wrapped).hexdigest(),
                    "id": row["recording_id"],
                },
            )
        migrated += 1
    return migrated


def _opus_head() -> bytes:
    # Version 1, mono, no pre-skip, 16 kHz input rate (informational), no gain.
    return b"OpusHead" + struct.pack("<BBHIhB", 1, 1, 0, 16000, 0, 0)


def _opus_tags() -> bytes:
    vendor = b"olive"
    return b"OpusTags" + struct.pack("<I", len(vendor)) + vendor + struct.pack("<I", 0)


def _ogg_page(packets: list[bytes], sequence: int, granule: int, flags: int) -> bytes:
    lacing = bytes(len(packet) for packet in packets)
    header = (
        b"OggS"
        + bytes((0, flags))
        + struct.pack("<QII", granule, 1, sequence)
        + b"\x00\x00\x00\x00"  # CRC placeholder, filled below
        + bytes((len(lacing),))
        + lacing
    )
    page = bytearray(header + b"".join(packets))
    page[22:26] = struct.pack("<I", _ogg_crc(bytes(page)))
    return bytes(page)


def _ogg_crc(data: bytes) -> int:
    crc = 0
    for byte in data:
        crc = ((crc << 8) & 0xFFFFFFFF) ^ _CRC_TABLE[((crc >> 24) ^ byte) & 0xFF]
    return crc


def _build_crc_table() -> tuple[int, ...]:
    table = []
    for byte in range(256):
        value = byte << 24
        for _ in range(8):
            value = ((value << 1) ^ (0x04C11DB7 if value & 0x80000000 else 0)) & 0xFFFFFFFF
        table.append(value)
    return tuple(table)


_CRC_TABLE = _build_crc_table()
