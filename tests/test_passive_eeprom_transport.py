from __future__ import annotations

import struct

import pytest

from ethercat_debug_tool.backends.passive_discovery import NpcapEthercatTransport, PassiveDiscoveryError


class EepromTransport(NpcapEthercatTransport):
    def __init__(self) -> None:
        super().__init__("mock")
        self.image = bytearray(range(32))
        self.owner = 0
        self.status = 0x00C0
        self.word = 0
        self.pending_data = b""
        self.commands: list[tuple[int, int]] = []

    def aprd(self, position: int, address: int, length: int) -> tuple[bytes, int]:
        assert position == 1
        if address == 0x0500:
            return bytes([self.owner, 0])[:length], 1
        if address == 0x0502:
            return self.status.to_bytes(2, "little"), 1
        if address == 0x0508:
            return bytes(self.image[self.word * 2:self.word * 2 + length]), 1
        raise AssertionError(hex(address))

    def apwr(self, position: int, address: int, data: bytes) -> None:
        assert position == 1
        if address == 0x0500:
            self.owner = data[0] & 1
        elif address == 0x0508:
            self.pending_data = data
        elif address == 0x0502:
            if len(data) == 2:
                self.status &= ~0x7800
            else:
                assert len(data) == 6
                command, self.word, _ = struct.unpack("<HHH", data)
                self.commands.append((command, self.word))
                if command == 0x0201:
                    self.image[self.word * 2:self.word * 2 + 2] = self.pending_data
        else:
            raise AssertionError(hex(address))


def test_odd_word_read_aligns_eeprom_command_and_restores_owner() -> None:
    transport = EepromTransport()
    assert transport.eeprom_read(1, 1, 2) == bytes(range(2, 6))
    assert transport.commands == [(0x0100, 0), (0x0100, 2)]
    assert transport.owner == 0


def test_write_uses_eeprom_controller_and_restores_owner() -> None:
    transport = EepromTransport()
    transport.eeprom_write(1, 3, b"\xAA\xBB")
    assert transport.commands == [(0x0201, 3)]
    assert transport.image[6:8] == b"\xAA\xBB"
    assert transport.owner == 0


def test_old_loading_and_crc_errors_do_not_block_raw_read_or_write(monkeypatch):
    transport = EepromTransport()
    transport.owner = 1
    original_read = transport.aprd

    def persistent_loading_flags(position, address, length):
        if address == 0x0502:
            return (0x18C0).to_bytes(2, "little"), 1
        return original_read(position, address, length)

    monkeypatch.setattr(transport, "aprd", persistent_loading_flags)
    assert transport.eeprom_read(1, 0, 2) == bytes(range(4))
    transport.eeprom_write(1, 0, b"\x12\x34")
    assert transport.image[:2] == b"\x12\x34" and transport.owner == 1


@pytest.mark.parametrize("flag,attempts", [(0x2000, 3), (0x4000, 1)])
def test_nack_retries_are_bounded_and_write_enable_errors_fail(monkeypatch, flag, attempts):
    transport = EepromTransport()
    transport.owner = 1
    write = transport.apwr

    def reject_command(position, address, data):
        write(position, address, data)
        if address == 0x0502 and len(data) == 6:
            transport.status |= flag

    monkeypatch.setattr(transport, "apwr", reject_command)
    with pytest.raises(PassiveDiscoveryError, match="0x0502="):
        transport.eeprom_write(1, 0, b"\xAA\xBB")
    assert len(transport.commands) == attempts and transport.owner == 1


def test_busy_timeout_does_not_write_ownership_or_commands(monkeypatch):
    transport = EepromTransport()
    transport.status |= 0x8000
    monkeypatch.setattr(transport, "apwr", lambda *args: pytest.fail("write while busy"))
    with pytest.raises(PassiveDiscoveryError, match="Busy 超时"):
        transport.eeprom_read(1, 0, 2)


def test_primary_error_is_preserved_if_restoring_owner_also_fails(monkeypatch):
    transport = EepromTransport()
    transport.owner = 1
    write = transport.apwr

    def failed_write(position, address, data):
        if address == 0x0508:
            raise PassiveDiscoveryError("data write lost")
        if address == 0x0500 and data == b"\x01":
            raise PassiveDiscoveryError("restore lost")
        write(position, address, data)

    monkeypatch.setattr(transport, "apwr", failed_write)
    with pytest.raises(PassiveDiscoveryError, match="data write lost.*控制权归还失败.*restore lost"):
        transport.eeprom_write(1, 0, b"\xAA\xBB")
