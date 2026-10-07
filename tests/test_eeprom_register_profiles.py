from dataclasses import replace
from pathlib import Path

import pytest

from ethercat_debug_tool.backends.base import CommunicationError
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


def test_full_read_uses_bounded_blocks(monkeypatch) -> None:
    backend = MockBackend()
    backend.connect("demo0")
    try:
        backend.scan()
        original_read = backend.eeprom_read_block
        requests = []

        def tracked_read(position, word, byte_count):
            requests.append((word, byte_count))
            return original_read(position, word, byte_count)

        monkeypatch.setattr(backend, "eeprom_read_block", tracked_read)
        assert len(EepromService(backend).read_full(1)) == 2048
        assert requests == [(0, 128)] + [(word, 128) for word in range(0, 1024, 64)]
    finally:
        backend.disconnect()


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
        result = EepromService(backend, rediscovery_timeout_s=0).flash(
            1, target, device, auto_reset=True, progress=progress.append
        )
        assert result.bytes_read_back == 2048
        assert result.image_success
        assert result.comparison.target_sha256 == result.comparison.readback_sha256
        assert result.reset_sequence == (True, True, True)
        assert result.rediscovered is True and result.reload_verified is True
        stages = {item.stage for item in progress}
        assert {
            "write-verify",
            "full-verify",
            "reset",
            "reload-verify",
        } <= stages
    finally:
        backend.disconnect()


def test_flash_uses_xml_length_when_current_capacity_declaration_is_corrupt(sample_esi) -> None:
    backend = MockBackend()
    backend.connect("demo0")
    try:
        device = sample_esi.devices[0]
        target = SiiGenerator().generate(device).image
        backend._eeprom[0][0] ^= 1  # Current configuration CRC is invalid.
        backend._eeprom[0][0x7C:0x7E] = b"\xf0\x90"  # Declares 4,749,440 bytes.
        service = EepromService(backend)
        with pytest.raises(ValueError, match="容量未知"):
            service.read_capacity(1)

        result = service.flash(1, target, device, auto_reset=False)

        assert result.image_success
        assert result.bytes_read_back == len(target) == 2048
        assert service.read_capacity(1) == 2048
    finally:
        backend.disconnect()


def test_flash_uses_xml_length_when_current_header_is_valid(sample_esi) -> None:
    backend = MockBackend()
    backend.connect("demo0")
    try:
        backend._eeprom[0].extend(b"\xff" * 2048)
        device = replace(sample_esi.devices[0], byte_size=4096)
        target = SiiGenerator().generate(device).image
        service = EepromService(backend)
        assert service.read_capacity(1) == 2048

        result = service.flash(1, target, device, auto_reset=False)

        assert result.image_success
        assert result.bytes_read_back == 4096
        assert service.read_capacity(1) == 4096
    finally:
        backend.disconnect()


def test_flash_writes_all_words_before_any_read_and_defaults_to_no_reset(sample_esi, monkeypatch):
    backend = MockBackend()
    backend.connect("demo0")
    try:
        target = SiiGenerator().generate(sample_esi.devices[0]).image
        backend._eeprom[0][:] = target
        events = []
        sleeps = []
        read, write = backend.eeprom_read_block, backend.eeprom_write

        def tracked_write(position, word, data):
            events.append(("write", word))
            write(position, word, data)

        def tracked_read(position, word, size):
            assert sum(kind == "write" for kind, _ in events) == len(target) // 2
            events.append(("read", word))
            return read(position, word, size)

        monkeypatch.setattr(backend, "eeprom_write", tracked_write)
        monkeypatch.setattr(backend, "eeprom_read_block", tracked_read)
        monkeypatch.setattr(backend, "register_write", lambda *_: pytest.fail("Reset must be opt-in"))
        result = EepromService(backend, sleep=sleeps.append).flash(1, target, sample_esi.devices[0])
        assert result.image_success and result.words_written == len(target) // 2
        assert events[:len(target) // 2] == [("write", word) for word in range(len(target) // 2)]
        assert len(events) == len(target) // 2 + 16
        assert result.reset_sequence is None and result.reload_verified is None
        assert sleeps == []
    finally:
        backend.disconnect()


def test_flash_has_no_fixed_wait_after_completed_controller_commands(sample_esi) -> None:
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
        backend._eeprom[0][:] = target
        backend._eeprom[0][0] ^= 0xFF
        sleeps = []
        result = EepromService(backend, sleep=sleeps.append).flash(
            1, target, device, auto_reset=False
        )
        assert result.image_success and result.words_written == len(target) // 2
        assert sleeps == []
        assert result.reset_sequence is None
    finally:
        backend.disconnect()


@pytest.mark.parametrize("first_write", ["dropped", "wkc_error"])
def test_flash_reports_errors_without_rewriting(sample_esi, monkeypatch, first_write) -> None:
    backend = MockBackend()
    backend.connect("demo0")
    try:
        slave = backend.scan()[0]
        device = replace(sample_esi.devices[0], vendor_id=slave.identity.vendor_id,
                         product_code=slave.identity.product_code, revision=slave.identity.revision)
        target = SiiGenerator().generate(device).image
        backend._eeprom[0][:] = target
        backend._eeprom[0][0:2] = b"\x00\x00"
        original_write = backend.eeprom_write
        calls = 0
        sleeps = []

        def transient_write(position, word, data):
            nonlocal calls
            if word == 0:
                calls += 1
                if calls == 1:
                    if first_write == "wkc_error":
                        raise CommunicationError("APWR WKC != 1")
                    return
            original_write(position, word, data)

        monkeypatch.setattr(backend, "eeprom_write", transient_write)
        service = EepromService(backend, sleep=sleeps.append)
        if first_write == "wkc_error":
            with pytest.raises(CommunicationError, match="word 0x0000.*WKC"):
                service.flash(1, target, device, auto_reset=False)
        else:
            result = service.flash(1, target, device, auto_reset=False)
            assert not result.image_success and result.comparison.first_difference == 0
            assert result.attempts == 1
        assert calls == 1
        assert sleeps == []
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
        result = EepromService(backend, sleep=lambda _: None).flash(
            1, target, device, auto_reset=False
        )
        assert writes[:2] == [0, 1]
        assert len(writes) > 2
        assert not result.image_success
        assert result.comparison.differing_bytes > 0
        assert result.attempts == 1 and writes.count(0) == 1
        assert result.reset_sequence is None
        for field in ("烧录失败", "expected=", "actual=", "word 0x0000"):
            assert field in result.image_verification
    finally:
        backend.disconnect()


def test_rediscovery_polls_until_slave_returns(monkeypatch, sample_esi) -> None:
    backend = MockBackend()
    backend.connect("demo0")
    clock = [0.0]
    scans = 0
    original_scan = backend.scan
    slave = original_scan()[0]
    device = replace(sample_esi.devices[0], vendor_id=slave.identity.vendor_id,
                     product_code=slave.identity.product_code, revision=slave.identity.revision)

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
        assert service._rediscover(1, device) is True
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
        result = EepromService(backend).flash(
            1,
            target,
            device,
            auto_reset=False,
            progress=progress.append,
            cancel=lambda: writes > 0,
        )

        assert writes > 0 and result.image_success
        assert all(not item.cancellable for item in progress)
    finally:
        backend.disconnect()


def test_corrupt_sii_can_still_be_backed_up_as_raw_bin(tmp_path) -> None:
    backend = MockBackend()
    backend.connect("demo0")
    try:
        slave = backend.scan()[0]
        backend._eeprom[0][0] ^= 0xFF
        backup = EepromService(backend).backup(1, tmp_path, slave, capacity=2048)
        assert backup.binary_path.read_bytes()[0] != 0x90
        assert backup.sha256
        assert list(tmp_path.glob("*.json")) == []
    finally:
        backend.disconnect()


def test_backups_do_not_overwrite_same_second(tmp_path, monkeypatch) -> None:
    backend = MockBackend()
    backend.connect("demo0")
    try:
        slave = backend.scan()[0]
        service = EepromService(backend)
        # A relative destination must still return the exact absolute exported filename.
        monkeypatch.chdir(tmp_path)
        first = service.backup(1, Path("BIN 输出, Motor"), slave)
        second = service.backup(1, tmp_path / "BIN 输出, Motor", slave)
        assert first.binary_path.is_absolute()
        assert first.binary_path.parent == tmp_path / "BIN 输出, Motor"
        assert first.binary_path != second.binary_path
        assert first.binary_path.read_bytes() == second.binary_path.read_bytes()
    finally:
        backend.disconnect()


@pytest.mark.parametrize("fill", [0, 255])
def test_blank_eeprom_supports_explicit_raw_read_and_reflash(sample_esi, fill):
    backend = MockBackend()
    backend.connect("demo0")
    try:
        backend._eeprom[0][:] = bytes([fill]) * 2048
        service = EepromService(backend)
        with pytest.raises(ValueError, match="容量未知"):
            service.read_full(1)
        assert service.read_full(1, capacity=2048) == bytes([fill]) * 2048
        device = sample_esi.devices[0]
        target = SiiGenerator().generate(device).image
        assert service.flash(1, target, device, auto_reset=False).image_success
    finally:
        backend.disconnect()


def test_old_eeprom_is_not_read_before_reprogramming(sample_esi, monkeypatch):
    backend = MockBackend()
    backend.connect("demo0")
    try:
        device = sample_esi.devices[0]
        target = SiiGenerator().generate(device).image
        read, write = backend.eeprom_read_block, backend.eeprom_write
        written = []

        def tracked_write(position, word, data):
            written.append(word)
            write(position, word, data)

        def unreadable_before_write(*args):
            if len(written) != len(target) // 2:
                raise CommunicationError("Old EEPROM cannot be read")
            return read(*args)

        monkeypatch.setattr(backend, "eeprom_write", tracked_write)
        monkeypatch.setattr(backend, "eeprom_read_block", unreadable_before_write)
        result = EepromService(backend).flash(1, target, device)
        assert result.image_success and result.words_written == len(target) // 2
        assert result.bytes_read_back == len(target)
    finally:
        backend.disconnect()


def test_partial_write_failure_stops_at_the_failed_word(sample_esi, monkeypatch):
    backend = MockBackend()
    backend.connect("demo0")
    try:
        device = sample_esi.devices[0]
        target = SiiGenerator().generate(device).image
        backend._eeprom[0][:] = bytes(2048)
        write = backend.eeprom_write
        calls = []

        def dropped_write(position, word, data):
            calls.append(word)
            if len(calls) == 5:
                raise CommunicationError("write failed halfway")
            write(position, word, data)

        monkeypatch.setattr(backend, "eeprom_write", dropped_write)
        with pytest.raises(CommunicationError, match="word 0x0004.*已写入 4 Word.*write failed halfway"):
            EepromService(backend).flash(1, target, device, auto_reset=False)
        assert calls == [0, 1, 2, 3, 4]
        assert bytes(backend._eeprom[0][:8]) == target[:8]
    finally:
        backend.disconnect()


def test_permanent_full_read_failure_is_programming_failure(sample_esi, monkeypatch):
    backend = MockBackend()
    backend.connect("demo0")
    try:
        def unreadable(*args):
            raise CommunicationError("no EEPROM response")

        monkeypatch.setattr(backend, "eeprom_read_block", unreadable)
        device = sample_esi.devices[0]
        with pytest.raises(CommunicationError, match="烧录失败.*完整回读失败"):
            EepromService(backend, sleep=lambda _: None).flash(
                1, SiiGenerator().generate(device).image, device, auto_reset=False,
            )
    finally:
        backend.disconnect()


def test_reset_failure_is_separate_from_completed_image(sample_esi, monkeypatch):
    backend = MockBackend()
    backend.connect("demo0")
    try:
        def failed_reset(*args):
            raise CommunicationError("RES write failed")

        monkeypatch.setattr(backend, "register_write", failed_reset)
        device = sample_esi.devices[0]
        result = EepromService(backend, rediscovery_timeout_s=0).flash(
            1, SiiGenerator().generate(device).image, device, auto_reset=True,
        )
        assert result.image_success and result.reload_verified is False
        assert "RES write failed" in result.reload_error
    finally:
        backend.disconnect()


def test_rediscovery_does_not_accept_a_different_slave_at_same_position(sample_esi):
    backend = MockBackend()
    backend.connect("demo0")
    try:
        assert not EepromService(backend, rediscovery_timeout_s=0)._rediscover(1, sample_esi.devices[0])
    finally:
        backend.disconnect()


@pytest.mark.parametrize("raw", [b"\x01", b"\x01\x02\x03", b"\xff\xff", bytes(128), b"\xff" * 2048])
def test_raw_bin_programming_preserves_bytes_and_neighbours(tmp_path, raw):
    backend = MockBackend()
    backend.connect("demo0")
    try:
        backend._eeprom[0][:] = b"\x5a" * 2048
        source = tmp_path / "raw.bin"
        source.write_bytes(raw)
        result = EepromService(backend).restore(1, source)
        assert result.image_success and result.comparison.equal
        assert result.bytes_read_back == len(raw)
        assert result.words_written == (len(raw) + 1) // 2
        assert result.semantic_valid is None and not result.sii_valid
        assert bytes(backend._eeprom[0][:len(raw)]) == raw
        assert bytes(backend._eeprom[0][len(raw):]) == b"\x5a" * (2048 - len(raw))
        assert result.reset_sequence is None
    finally:
        backend.disconnect()


def test_sii_semantics_do_not_override_exact_programming_result(sample_esi):
    backend = MockBackend()
    backend.connect("demo0")
    try:
        target = SiiGenerator().generate(sample_esi.devices[0]).image
        different = replace(sample_esi.devices[0], product_code=0x12345678)
        result = EepromService(backend).flash(1, target, different)
        assert result.image_success and result.sii_valid and not result.semantic_valid
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
    for chip_id in (b"\x52\x92", b"\x53\x92", b"\x52\xE2"):
        assert _chip_from_identification_registers(b"\xAE", chip_id) == (
            "E252",
            "LAN9252_COMPATIBLE",
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
        with pytest.raises(RuntimeError, match="写入失败：寄存器当前值已变化"):
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
