from dataclasses import replace

import pytest

from ethercat_debug_tool.backends.base import CommunicationError, EepromReadback
from ethercat_debug_tool.backends.mock import MockBackend
from ethercat_debug_tool.backends.pysoem_backend import (
    _chip_from_identification_registers,
    _chip_from_register,
)
from ethercat_debug_tool.esc_profiles.profiles import ProfileRegistry, RegisterFamily
from ethercat_debug_tool.models import AccessSemantics
from ethercat_debug_tool.services.eeprom_service import EepromService, compare_images
from ethercat_debug_tool.services.register_service import RegisterService
from ethercat_debug_tool.sii.generator import SiiGenerator


def test_compare_reports_first_byte_and_hash() -> None:
    result = compare_images(b"\x00\x01", b"\x00\x02")
    assert not result.equal and result.differing_bytes == 1 and result.first_difference == 1
    assert result.target_sha256 != result.readback_sha256


def test_eeprom_rediscovery_defaults_are_bounded_for_quick_recovery() -> None:
    service = EepromService(MockBackend())
    assert service.rediscovery_timeout_s == 3.0
    assert service.rediscovery_poll_s == 0.1


def test_mock_flash_does_not_create_backup_and_fully_verifies(sample_esi) -> None:
    backend = MockBackend()
    backend.connect("demo0")
    try:
        slave = backend.scan()[0]
        device = replace(
            sample_esi.devices[0],
            vendor_id=slave.identity.vendor_id,
            product_code=slave.identity.product_code,
            revision=slave.identity.revision,
        )
        target = SiiGenerator().generate(device).image
        backend._eeprom[0][0] ^= 0xFF
        progress = []
        result = EepromService(backend, stability_wait_s=0, rediscovery_timeout_s=0).flash(
            1, target, device, auto_reset=True, progress=progress.append
        )
        assert result.bytes_read_back == 2048
        assert result.image_success
        assert result.comparison.target_sha256 == result.comparison.readback_sha256
        assert result.reset_sequence == (True, True, True)
        assert result.rediscovered is True and result.reload_verified is True
        stages = {item.stage for item in progress}
        assert {
            "read-current",
            "write-verify",
            "stability-wait",
            "full-verify",
            "reset",
            "reload-verify",
        } <= stages
    finally:
        backend.disconnect()


@pytest.mark.parametrize("first_read", ["mismatch", "wkc_error"])
def test_flash_recovers_when_second_word_read_is_correct(sample_esi, monkeypatch, first_read) -> None:
    backend = MockBackend()
    backend.connect("demo0")
    try:
        slave = backend.scan()[0]
        device = replace(sample_esi.devices[0], vendor_id=slave.identity.vendor_id,
                         product_code=slave.identity.product_code, revision=slave.identity.revision)
        target = SiiGenerator().generate(device).image
        backend._eeprom[0][0:2] = b"\x00\x00"
        original_read = backend.eeprom_read_checked
        calls = 0
        sleeps = []

        def transient_read(position, word):
            nonlocal calls
            result = original_read(position, word)
            if word == 0:
                calls += 1
                if calls == 1:
                    if first_read == "wkc_error":
                        raise CommunicationError("FPRD WKC != 1")
                    return EepromReadback(b"\x00\x00" + result.data[2:], 1, 0x00C0)
            return result

        monkeypatch.setattr(backend, "eeprom_read_checked", transient_read)
        result = EepromService(backend, stability_wait_s=0, sleep=sleeps.append).flash(
            1, target, device, auto_reset=False
        )
        assert result.image_success
        assert calls == 2
        assert sleeps == [0.02, 0]
    finally:
        backend.disconnect()


def test_flash_persistent_mismatch_finishes_writes_then_reports_diagnostics(sample_esi, monkeypatch) -> None:
    backend = MockBackend()
    backend.connect("demo0")
    try:
        slave = backend.scan()[0]
        device = replace(sample_esi.devices[0], vendor_id=slave.identity.vendor_id,
                         product_code=slave.identity.product_code, revision=slave.identity.revision)
        target = SiiGenerator().generate(device).image
        backend._eeprom[0][0:4] = b"\x00\x00\x00\x00"
        original_write = backend.eeprom_write
        writes = []

        def failed_first_write(position, word, data):
            writes.append(word)
            if word != 0:
                original_write(position, word, data)

        monkeypatch.setattr(backend, "eeprom_write", failed_first_write)
        result = EepromService(backend, stability_wait_s=0, sleep=lambda _: None).flash(
            1, target, device, auto_reset=False
        )
        assert writes[:2] == [0, 1]
        assert len(writes) > 2
        assert not result.image_success
        assert result.comparison.differing_bytes > 0
        for field in ("expected=", "actual=", "WKC=1", "word_retries=3", "full_retries=2", "0x0502="):
            assert field in result.image_verification
    finally:
        backend.disconnect()


def test_rediscovery_polls_until_slave_returns(monkeypatch) -> None:
    backend = MockBackend()
    backend.connect("demo0")
    clock = [0.0]
    scans = 0
    original_scan = backend.scan

    def delayed_scan():
        nonlocal scans
        scans += 1
        return [] if scans < 3 else original_scan()

    def advance(seconds: float) -> None:
        clock[0] += seconds

    monkeypatch.setattr(backend, "scan", delayed_scan)
    try:
        service = EepromService(
            backend,
            rediscovery_timeout_s=3,
            rediscovery_poll_s=0.5,
            sleep=advance,
            monotonic=lambda: clock[0],
        )
        assert service._rediscover(1) is True
        assert scans == 3
        assert clock[0] == 1.0
    finally:
        backend.disconnect()


def test_flash_ignores_cancel_after_programming_begins(sample_esi, monkeypatch) -> None:
    backend = MockBackend()
    backend.connect("demo0")
    try:
        slave = backend.scan()[0]
        device = replace(
            sample_esi.devices[0],
            vendor_id=slave.identity.vendor_id,
            product_code=slave.identity.product_code,
            revision=slave.identity.revision,
        )
        target = SiiGenerator().generate(device).image
        backend._eeprom[0][0:4] = b"\x00\x00\x00\x00"
        original_write = backend.eeprom_write
        writes = 0
        progress = []

        def tracked_write(position: int, word_address: int, data: bytes) -> None:
            nonlocal writes
            original_write(position, word_address, data)
            writes += 1

        monkeypatch.setattr(backend, "eeprom_write", tracked_write)
        result = EepromService(backend, stability_wait_s=0).flash(
            1,
            target,
            device,
            auto_reset=False,
            progress=progress.append,
            cancel=lambda: writes > 0,
        )

        assert writes > 0 and result.image_success
        assert all(not item.cancellable for item in progress if item.stage != "read-current")
    finally:
        backend.disconnect()


def test_corrupt_sii_can_still_be_backed_up_as_raw_bin(tmp_path) -> None:
    backend = MockBackend()
    backend.connect("demo0")
    try:
        slave = backend.scan()[0]
        backend._eeprom[0][0] ^= 0xFF
        backup = EepromService(backend).backup(1, tmp_path, slave)
        assert backup.binary_path.read_bytes()[0] != 0x90
        assert backup.sha256
        assert list(tmp_path.glob("*.json")) == []
    finally:
        backend.disconnect()


def test_profiles_are_distinct_and_not_inferred_from_counts() -> None:
    profiles = ProfileRegistry()
    assert profiles.resolve(esi_type="E252").chip_model == "E252"
    assert profiles.resolve(chip_register=(0xE253).to_bytes(4, "little")).chip_model == "E253"
    assert profiles.get("E101").register_family is RegisterFamily.ET1100_COMPATIBLE
    assert profiles.get("E101").chip_model != "ET1100"
    assert profiles.resolve(esi_type="unknown").chip_model == "Generic ESC"
    al_control = next(item for item in profiles.standard_registers() if item["address"] == 0x0120)
    assert al_control["access"] == "RW" and len(al_control["bit_fields"]) >= 2
    assert _chip_from_register(b"\x00" * 4, fmmu_count=3, sm_count=4, ram_kib=4) == (
        "LAN9252",
        "LAN9252_COMPATIBLE",
    )
    assert _chip_from_register(b"\xE2\x52\x00\x00") == ("E252", "LAN9252_COMPATIBLE")
    assert _chip_from_register(b"\x00\x00\x00\x00") == ("Generic ESC", "GENERIC")


def test_authoritative_esc_identification_registers() -> None:
    assert _chip_from_identification_registers(b"\x11", b"\x00\x00") == (
        "ET1100",
        "ET1100_COMPATIBLE",
    )
    assert _chip_from_identification_registers(b"\x00", b"\x52\x92") == (
        "LAN9252",
        "LAN9252_COMPATIBLE",
    )
    assert _chip_from_identification_registers(b"\x00", b"\x53\x92") == (
        "LAN9253",
        "LAN9253_COMPATIBLE",
    )
    assert _chip_from_identification_registers(b"\x00", b"\x00\x00") == (
        "Generic ESC",
        "GENERIC",
    )


def test_register_catalog_error_counters_and_pdi_registers() -> None:
    catalog = ProfileRegistry().standard_registers()
    by_address = {int(item["address"]): item for item in catalog}
    for port in range(4):
        counter = by_address[0x0300 + port]
        assert counter["name"] == f"RX Error Counter Port {port}"
        assert counter["width"] == 1 and counter["access"] == "WAC"
    pdi_control = by_address[0x0140]
    assert pdi_control["name"] == "PDI Control" and pdi_control["width"] == 2
    assert pdi_control["access"] == "RW" and pdi_control["group"] == "PDI"
    al_event = by_address[0x0220]
    assert al_event["access"] == "W1C"


def test_register_write_semantics_and_concurrent_change_guard() -> None:
    backend = MockBackend()
    backend.connect("demo0")
    try:
        service = RegisterService(backend)
        plan = service.prepare_write(1, 0x0100, b"\x12\x34", AccessSemantics.RW, True)
        result = service.execute_write(plan)
        assert result.verified and result.readback == b"\x12\x34"
        stale = service.prepare_write(1, 0x0100, b"\x56\x78", AccessSemantics.RW, True)
        backend.register_write(1, 0x0100, b"\x00\x00", 2000)
        with pytest.raises(RuntimeError, match="changed"):
            service.execute_write(stale)
        with pytest.raises(PermissionError):
            service.prepare_write(1, 0x0000, b"\x01", AccessSemantics.RO, True)
    finally:
        backend.disconnect()


def test_write_only_register_does_not_attempt_pre_read(monkeypatch) -> None:
    backend = MockBackend()
    backend.connect("demo0")
    writes: list[tuple[int, int, bytes, int]] = []
    monkeypatch.setattr(
        backend,
        "register_read",
        lambda *_args: (_ for _ in ()).throw(AssertionError("WO must not be read")),
    )
    monkeypatch.setattr(
        backend,
        "register_write",
        lambda position, address, data, timeout: writes.append((position, address, data, timeout)),
    )
    try:
        service = RegisterService(backend)
        plan = service.prepare_write(1, 0x0040, b"R", AccessSemantics.WO, True)
        assert plan.current == b"" and plan.changed_mask == b""
        result = service.execute_write(plan)
        assert writes == [(1, 0x0040, b"R", 2000)]
        assert result.verified is None and result.readback is None
    finally:
        backend.disconnect()


def test_known_register_write_rejects_wrong_width_and_semantics() -> None:
    backend = MockBackend()
    backend.connect("demo0")
    try:
        service = RegisterService(backend)
        with pytest.raises(ValueError, match="exactly 4 bytes"):
            service.prepare_write(1, 0x0100, b"\x12", AccessSemantics.RW, True, expected_width=4)
        with pytest.raises(ValueError, match="semantics"):
            service.prepare_write(
                1,
                0x0100,
                b"\x12\x34\x56\x78",
                AccessSemantics.W1C,
                True,
                expected_width=4,
                expected_semantics=AccessSemantics.RW,
            )
    finally:
        backend.disconnect()
