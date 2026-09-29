from __future__ import annotations

import pytest

from ethercat_debug_tool.master_state import (
    InvalidMasterTransition,
    MasterStateMachine,
    StaleMasterSession,
)
from ethercat_debug_tool.models import (
    BackendMode,
    EtherCatState,
    MasterPhase,
    SlaveIdentity,
    SlaveInfo,
)


def _slave(state: EtherCatState = EtherCatState.PRE_OP) -> SlaveInfo:
    return SlaveInfo(
        position=1,
        name="Demo slave",
        identity=SlaveIdentity(2, 3, 4, 5),
        state=state,
        al_status=0,
        input_size=2,
        output_size=2,
        configured_address=1001,
    )


def test_cycle_cannot_start_from_disconnected() -> None:
    machine = MasterStateMachine(BackendMode.DEMO)

    with pytest.raises(InvalidMasterTransition, match="cycle_started is invalid from disconnected"):
        machine.cycle_started((_slave(),))

    assert machine.snapshot().phase is MasterPhase.DISCONNECTED


def test_state_read_failure_does_not_claim_a_running_cycle_stopped() -> None:
    machine = MasterStateMachine(BackendMode.DEMO)
    machine.connect_succeeded("demo0")
    machine.scan_succeeded((_slave(),))
    machine.cycle_started((_slave(EtherCatState.OP),))
    session_id = machine.session_id

    machine.state_read_failed("temporary read failure", expected_session=session_id)

    snapshot = machine.snapshot()
    assert snapshot.phase is MasterPhase.CYCLIC
    assert snapshot.cycle_running is True
    assert snapshot.slaves[0].state is EtherCatState.OP
    assert snapshot.last_error == "temporary read failure"
    assert snapshot.slaves[0].state_error == "temporary read failure"
    machine.states_updated((_slave(EtherCatState.OP),), expected_session=session_id)
    assert machine.snapshot().slaves[0].state_error is None


def test_stale_worker_event_cannot_change_current_session() -> None:
    machine = MasterStateMachine(BackendMode.DEMO)
    machine.connect_succeeded("demo0")
    stale_session = machine.session_id
    machine.scan_succeeded((_slave(),))

    with pytest.raises(StaleMasterSession, match="event belongs to session"):
        machine.states_updated((), expected_session=stale_session)

    snapshot = machine.snapshot()
    assert snapshot.phase is MasterPhase.BUS_SCANNED
    assert snapshot.session_id != stale_session
    assert len(snapshot.slaves) == 1


def test_topology_change_during_state_update_advances_session() -> None:
    machine = MasterStateMachine(BackendMode.DEMO)
    machine.connect_succeeded("demo0")
    machine.scan_succeeded((_slave(),))
    previous_session = machine.session_id

    changed = machine.states_updated(())

    assert changed is True
    assert machine.snapshot().phase is MasterPhase.ADAPTER_OPEN
    assert machine.session_id == previous_session + 1



def test_preop_leaves_pdo_configured_phase_without_changing_session():
    machine = MasterStateMachine(BackendMode.DEMO)
    machine.connect_succeeded("demo0")
    machine.scan_succeeded((_slave(),))
    machine.pdo_configured((_slave(EtherCatState.SAFE_OP),))
    session = machine.session_id
    machine.states_updated((_slave(EtherCatState.PRE_OP),))
    assert machine.snapshot().phase is MasterPhase.BUS_SCANNED
    assert machine.session_id == session
