"""Raw Plaud Opus detection and Ogg Opus wrapping tests."""

from __future__ import annotations

import struct

import pytest

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
