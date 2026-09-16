"""Linked-workflow expansion, cycle rejection, versioning and the dry-run preview endpoint.

The behaviours locked in here are all ones that previously failed *silently* — a missing link
dispatched a step calling an instrument literally named "Library Workflows", a nested link shipped
through unexpanded, and an A->B->C->A cycle was accepted at save time and only broke at runtime.
Each of those is now a loud rejection, so each gets a test that asserts the rejection rather than
the old degraded output.
"""

import json
import os

import pytest
from httpx import AsyncClient, ASGITransport

from ivoryos_edge import workflows as wf
from ivoryos_edge.server import app


# --- helpers ------------------------------------------------------------------------------------

def step(instrument="dummy", action="test_method", args=None, **extra):
    block = {
        "id": 1,
        "uuid": 123456,
        "instrument": instrument,
        "action": action,
        "args": args or {},
        "arg_types": {},
        "return": "",
        "batch_action": False,
    }
    block.update(extra)
    return block


def link(name, params=None, ref=None):
    block = {
        "id": 1,
        "uuid": 999,
        "instrument": wf.LIBRARY_INSTRUMENT,
        "action": name,
        "args": params or {},
    }
    if ref is not None:
        block["ref"] = ref
    return block


def body(script=None, prep=None, cleanup=None, description=""):
    return {
        "description": description,
        "prep": prep or [],
        "script": script or [],
        "cleanup": cleanup or [],
    }


def write(workflows_dir, name, wf_body):
    wf.save_version(workflows_dir, name, wf_body)


@pytest.fixture
def workflows_dir(tmp_path):
    d = tmp_path / "workflows"
    d.mkdir()
    return str(d)


@pytest.fixture
def api_workflows_dir(tmp_path, monkeypatch):
    """Point the live endpoints at a scratch directory instead of the package's own workflows/."""
    d = tmp_path / "api_workflows"
    d.mkdir()
    monkeypatch.setattr("ivoryos_edge.server.WORKFLOWS_DIR", str(d))
    return str(d)


# --- naming / path safety -----------------------------------------------------------------------

@pytest.mark.parametrize("name", ["../escape", "a/b", "a\\b", ".", "..", ".versions", ""])
def test_unsafe_names_rejected(name):
    """A workflow name becomes a path segment and arrives from a URL path parameter, so traversal
    has to be refused before the name is ever joined onto WORKFLOWS_DIR."""
    with pytest.raises(wf.InvalidWorkflowName):
        wf.validate_name(name)


def test_ordinary_names_allowed():
    for name in ["wash", "wash_protocol", "Wash Protocol 2", "wash-v2"]:
        assert wf.validate_name(name) == name


# --- expansion ----------------------------------------------------------------------------------

def test_link_expands_inline(workflows_dir):
    write(workflows_dir, "wash", body(script=[step(args={"duration": 1}), step(args={"duration": 2})]))

    out = wf.expand_workflow_blocks([link("wash")], workflows_dir, "main")

    assert [b["method"] for b in out] == ["test_method", "test_method"]
    assert all(b["params"]["_parent_workflow"] == "wash" for b in out)
    assert all(b["params"]["_phase"] == "main" for b in out)


def test_link_substitutes_hash_params(workflows_dir):
    write(workflows_dir, "wash", body(script=[step(args={"duration": "#cycles"})]))

    out = wf.expand_workflow_blocks([link("wash", {"cycles": 7})], workflows_dir, "main")

    assert out[0]["params"]["duration"] == 7


def test_unmatched_placeholder_survives_expansion(workflows_dir):
    """An unresolved #var is left intact so the live run context can still resolve it later —
    matching substitute_workflow_vars' whole-value semantics in queue.py."""
    write(workflows_dir, "wash", body(script=[step(args={"duration": "#from_spreadsheet"})]))

    out = wf.expand_workflow_blocks([link("wash")], workflows_dir, "main")

    assert out[0]["params"]["duration"] == "#from_spreadsheet"


def test_missing_link_raises_instead_of_degrading(workflows_dir):
    """Previously this appended the raw block, so the executor received a step whose instrument was
    literally "Library Workflows" — a silent corruption that only surfaced once hardware moved."""
    with pytest.raises(wf.WorkflowNotFound):
        wf.expand_workflow_blocks([link("does_not_exist")], workflows_dir, "main")


def test_nested_link_expands(workflows_dir):
    """The old expander copied inner blocks verbatim, so a link inside a linked workflow shipped
    through unexpanded."""
    write(workflows_dir, "inner", body(script=[step(args={"duration": 1})]))
    write(workflows_dir, "outer", body(script=[link("inner"), step(args={"duration": 2})]))

    out = wf.expand_workflow_blocks([link("outer")], workflows_dir, "main")

    assert len(out) == 2
    assert all(b["instrument"] == "dummy" for b in out)
    # Innermost owner wins, so the Queue page still groups steps under the workflow they came from.
    assert out[0]["params"]["_parent_workflow"] == "inner"
    assert out[1]["params"]["_parent_workflow"] == "outer"
    assert out[0]["params"]["_parent_path"] == ["outer", "inner"]


def test_depth_cap_enforced(workflows_dir):
    write(workflows_dir, "w0", body(script=[step()]))
    for i in range(1, 6):
        write(workflows_dir, f"w{i}", body(script=[link(f"w{i - 1}")]))

    with pytest.raises(wf.WorkflowDepthError):
        wf.expand_workflow_blocks([link("w5")], workflows_dir, "main")


def test_runtime_cycle_is_caught(workflows_dir):
    """Files can go cyclic behind the API's back (hand-edited, or synced down from Cloud), so the
    expander defends itself rather than trusting save-time validation alone."""
    write(workflows_dir, "a", body(script=[step()]))
    write(workflows_dir, "b", body(script=[link("a")]))
    # Rewrite 'a' directly on disk to point back at 'b', bypassing save-time validation.
    with open(os.path.join(workflows_dir, "a.json"), "w") as fp:
        json.dump(body(script=[link("b")]), fp)

    with pytest.raises(wf.WorkflowCycleError):
        wf.expand_workflow_blocks([link("a")], workflows_dir, "main")


def test_inner_batch_flags_are_preserved(workflows_dir):
    """A linked subworkflow's per-sample/batch designations survive expansion, so a copy and a link
    of the same protocol describe the same execution. They used to diverge: the spreadsheet walk
    treats an unexpanded link as one unit and never sees the inner flags at all."""
    write(workflows_dir, "wash", body(script=[
        step(args={"duration": 1}, batch_action=True),
        step(args={"duration": 2}, batch_action=False),
    ]))

    out = wf.expand_workflow_blocks([link("wash")], workflows_dir, "main")

    assert [b.get("batch_action") for b in out] == [True, False]


def test_resolved_links_are_reported(workflows_dir):
    write(workflows_dir, "inner", body(script=[step()]))
    write(workflows_dir, "outer", body(script=[link("inner")]))

    resolved = []
    wf.expand_workflow_blocks([link("outer")], workflows_dir, "main", resolved=resolved)

    assert [r["name"] for r in resolved] == ["outer", "inner"]
    assert all(r["body_hash"] for r in resolved)
    assert [r["depth"] for r in resolved] == [0, 1]


def test_plain_blocks_pass_through_with_phase(workflows_dir):
    out = wf.expand_workflow_blocks(
        [{"instrument": "dummy", "method": "test_method", "params": {"duration": 1}, "returnVar": "x"}],
        workflows_dir,
        "cleanup",
    )
    assert out[0]["params"]["_phase"] == "cleanup"
    assert out[0]["params"]["_return_var"] == "x"


def test_plain_blocks_accept_the_saved_shape_too(workflows_dir):
    """A live run posts method/params; the preview endpoint posts the saved action/args shape.

    Both have to come back fully populated. Passing the saved shape through untouched produced
    steps with no method and no arguments, which made the preview silently understate what the
    hardware would be told to do.
    """
    out = wf.expand_workflow_blocks([step(args={"duration": 3})], workflows_dir, "main")

    assert out[0]["instrument"] == "dummy"
    assert out[0]["method"] == "test_method"
    assert out[0]["params"]["duration"] == 3


def test_saved_shape_keeps_batch_flag_and_return_var(workflows_dir):
    out = wf.expand_workflow_blocks(
        [step(args={"duration": 3}, batch_action=True, **{"return": "measured"})],
        workflows_dir,
        "main",
    )
    assert out[0]["batch_action"] is True
    assert out[0]["params"]["_return_var"] == "measured"


# --- versioning ---------------------------------------------------------------------------------

def test_save_is_append_only(workflows_dir):
    _, v1, created = wf.save_version(workflows_dir, "wash", body(script=[step(args={"duration": 1})]))
    assert (v1, created) == (1, True)

    _, v2, created = wf.save_version(workflows_dir, "wash", body(script=[step(args={"duration": 2})]))
    assert (v2, created) == (2, True)

    assert wf.list_versions(workflows_dir, "wash") == [1, 2]
    assert wf.read_version(workflows_dir, "wash", 1)["script"][0]["args"]["duration"] == 1
    assert wf.read_version(workflows_dir, "wash", 2)["script"][0]["args"]["duration"] == 2


def test_noop_save_does_not_burn_a_version(workflows_dir):
    """The Designer regenerates a random block uuid on every save, so a byte-comparison would call
    every save an edit. People hit save reflexively; a no-op must stay a no-op."""
    wf.save_version(workflows_dir, "wash", body(script=[step(args={"duration": 1})]))

    same = body(script=[step(args={"duration": 1})])
    same["script"][0]["uuid"] = 888888  # differs byte-wise, identical semantically
    _, version, created = wf.save_version(workflows_dir, "wash", same)

    assert created is False
    assert version == 1
    assert wf.list_versions(workflows_dir, "wash") == [1]


def test_pinned_reference_ignores_later_edits(workflows_dir):
    """The reproducibility guarantee: a pinned step runs the body it was built against, even after
    the source workflow moves on."""
    wf.save_version(workflows_dir, "wash", body(script=[step(args={"duration": 1})]))
    wf.save_version(workflows_dir, "wash", body(script=[step(args={"duration": 99})]))

    pinned = wf.expand_workflow_blocks(
        [link("wash", ref={"version": 1, "mode": "pinned"})], workflows_dir, "main"
    )
    assert pinned[0]["params"]["duration"] == 1

    latest = wf.expand_workflow_blocks(
        [link("wash", ref={"mode": "latest"})], workflows_dir, "main"
    )
    assert latest[0]["params"]["duration"] == 99


def test_pin_to_deleted_version_is_refused_not_silently_downgraded(workflows_dir):
    wf.save_version(workflows_dir, "wash", body(script=[step()]))

    with pytest.raises(wf.WorkflowNotFound):
        wf.expand_workflow_blocks(
            [link("wash", ref={"version": 42, "mode": "pinned"})], workflows_dir, "main"
        )


def test_legacy_workflow_is_adopted_as_v1(workflows_dir):
    """A file written before versioning existed (or synced down from Cloud) picks up a version
    lazily on first read, rather than needing a migration step."""
    with open(os.path.join(workflows_dir, "legacy.json"), "w") as fp:
        json.dump(body(script=[step()]), fp)

    assert wf.head_version(workflows_dir, "legacy") == 1
    assert wf.list_versions(workflows_dir, "legacy") == [1]


def test_versions_dir_is_not_listed_as_a_workflow(workflows_dir):
    wf.save_version(workflows_dir, "wash", body(script=[step()]))
    assert wf.list_workflow_names(workflows_dir) == ["wash"]


# --- dependency graph ---------------------------------------------------------------------------

def test_dependents_finds_linkers_only(workflows_dir):
    write(workflows_dir, "wash", body(script=[step()]))
    write(workflows_dir, "screening_a", body(script=[link("wash")]))
    write(workflows_dir, "screening_b", body(script=[link("wash")]))
    # A copy inlines the blocks and holds no reference, so it must NOT show up as a dependent.
    write(workflows_dir, "copied", body(script=[step()]))

    assert wf.dependents(workflows_dir, "wash") == ["screening_a", "screening_b"]


def test_find_cycle_detects_indirect_loop(workflows_dir):
    """Hiding the current workflow from the toolbox only ever stopped A->A. This is the A->B->C->A
    case that used to be accepted at save time and break at runtime."""
    write(workflows_dir, "c", body(script=[step()]))
    write(workflows_dir, "b", body(script=[link("c")]))
    write(workflows_dir, "a", body(script=[link("b")]))

    # Now try to make 'c' link back to 'a'.
    cycle = wf.find_cycle(workflows_dir, "c", body(script=[link("a")]))

    assert cycle == ["c", "a", "b", "c"]


def test_find_cycle_allows_a_dag(workflows_dir):
    """Two workflows both linking the same shared one is a diamond, not a cycle."""
    write(workflows_dir, "shared", body(script=[step()]))
    write(workflows_dir, "left", body(script=[link("shared")]))

    assert wf.find_cycle(workflows_dir, "right", body(script=[link("shared"), link("left")])) is None


# --- tags ---------------------------------------------------------------------------------------

def test_tags_round_trip(workflows_dir):
    write(workflows_dir, "wash", body(script=[step()]))
    assert wf.set_tags(workflows_dir, "wash", ["Screening", "calibration"]) == ["Screening", "calibration"]
    assert wf.get_tags(workflows_dir, "wash") == ["Screening", "calibration"]


def test_tags_are_normalised(workflows_dir):
    """Trimmed, blanks dropped, deduped case-insensitively — otherwise 'Screening' and 'screening'
    quietly become two different buckets and the filter stops meaning anything."""
    write(workflows_dir, "wash", body(script=[step()]))
    assert wf.set_tags(workflows_dir, "wash", ["  screening ", "", "Screening", "  ", "prep"]) \
        == ["screening", "prep"]


def test_tags_are_not_part_of_the_versioned_body(workflows_dir):
    """Re-filing a workflow must not count as editing the protocol: no new version, and a pinned
    reference keeps resolving to exactly the same steps."""
    wf.save_version(workflows_dir, "wash", body(script=[step()]))
    before = wf.read_head(workflows_dir, "wash")

    wf.set_tags(workflows_dir, "wash", ["screening"])

    after = wf.read_head(workflows_dir, "wash")
    assert after["body_hash"] == before["body_hash"]
    assert wf.list_versions(workflows_dir, "wash") == [1]


def test_meta_file_is_not_listed_as_a_workflow(workflows_dir):
    write(workflows_dir, "wash", body(script=[step()]))
    wf.set_tags(workflows_dir, "wash", ["screening"])
    assert wf.list_workflow_names(workflows_dir) == ["wash"]


def test_deleting_a_workflow_drops_its_tags(workflows_dir):
    """Otherwise a later workflow that reused the name would silently inherit them."""
    write(workflows_dir, "wash", body(script=[step()]))
    wf.set_tags(workflows_dir, "wash", ["screening"])
    wf.delete_workflow(workflows_dir, "wash")

    write(workflows_dir, "wash", body(script=[step()]))
    assert wf.get_tags(workflows_dir, "wash") == []


def test_all_tags_ignores_deleted_workflows(workflows_dir):
    write(workflows_dir, "a", body(script=[step()]))
    write(workflows_dir, "b", body(script=[step()]))
    wf.set_tags(workflows_dir, "a", ["keep"])
    wf.set_tags(workflows_dir, "b", ["gone"])
    os.remove(wf.workflow_path(workflows_dir, "b"))  # removed behind the API's back

    assert wf.all_tags(workflows_dir) == ["keep"]


# --- endpoints ----------------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_save_rejects_self_reference(api_workflows_dir):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await ac.post("/api/workflows/wash", json=body(script=[step()]))
        res = await ac.post("/api/workflows/wash", json=body(script=[link("wash")]))

    assert res.status_code == 400, res.text
    assert "cycle" in res.json()["error"].lower()


@pytest.mark.asyncio
async def test_save_rejects_indirect_cycle(api_workflows_dir):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await ac.post("/api/workflows/c", json=body(script=[step()]))
        await ac.post("/api/workflows/b", json=body(script=[link("c")]))
        await ac.post("/api/workflows/a", json=body(script=[link("b")]))

        res = await ac.post("/api/workflows/c", json=body(script=[link("a")]))

    assert res.status_code == 400, res.text
    assert "c -> a -> b -> c" in res.json()["error"]


@pytest.mark.asyncio
async def test_save_rejects_dangling_link(api_workflows_dir):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        res = await ac.post("/api/workflows/a", json=body(script=[link("nope")]))

    assert res.status_code == 400, res.text
    assert "no longer exists" in res.json()["error"]


@pytest.mark.asyncio
async def test_save_reports_version_and_dependents(api_workflows_dir):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await ac.post("/api/workflows/wash", json=body(script=[step()]))
        await ac.post("/api/workflows/screening", json=body(script=[link("wash")]))

        res = await ac.post("/api/workflows/wash", json=body(script=[step(args={"duration": 5})]))

    payload = res.json()
    assert payload["version"] == 2
    assert payload["created_version"] is True
    # This is what the save-time impact warning renders — the user finds out they are about to
    # change someone else's workflow while they still have the context to decide.
    assert payload["dependents"] == ["screening"]


@pytest.mark.asyncio
async def test_expand_endpoint_flattens_without_queueing(api_workflows_dir):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await ac.post("/api/workflows/wash", json=body(script=[step(), step()]))

        res = await ac.post("/api/workflows/expand", json={
            "prep": [],
            "sequence": [link("wash"), step()],
            "cleanup": [],
        })

        runs_before = await ac.get("/api/queue/runs")

    payload = res.json()
    assert payload["counts"]["sequence"] == 3
    assert payload["counts"]["total"] == 3
    assert [r["name"] for r in payload["resolved_links"]] == ["wash"]
    # Every step the panel renders needs a method to name and its real arguments — the Designer
    # posts the saved action/args shape here, not the run payload's method/params.
    assert all(s["method"] for s in payload["sequence"])
    # Nothing was queued — this is a preview, not a submission.
    assert all(r["name"] != "Unnamed Workflow" for r in runs_before.json()["runs"])


@pytest.mark.asyncio
async def test_expand_endpoint_surfaces_the_same_error_as_dispatch(api_workflows_dir):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        res = await ac.post("/api/workflows/expand", json={"sequence": [link("missing")]})

    assert res.status_code == 400, res.text
    assert "missing" in res.json()["error"]


@pytest.mark.asyncio
async def test_expand_route_is_not_shadowed_by_the_name_route(api_workflows_dir):
    """`/api/workflows/expand` must not be read as a workflow named "expand"."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        res = await ac.post("/api/workflows/expand", json={"sequence": []})

    assert res.status_code == 200, res.text
    assert "counts" in res.json()


@pytest.mark.asyncio
async def test_run_is_refused_when_a_link_is_missing(api_workflows_dir):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        res = await ac.post("/api/queue/runs", json={
            "name": "Broken Run",
            "sequence": [link("gone")],
        })

    assert res.status_code == 400, res.text
    assert "gone" in res.json()["error"]


@pytest.mark.asyncio
async def test_versions_endpoint_lists_newest_first(api_workflows_dir):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await ac.post("/api/workflows/wash", json=body(script=[step(args={"duration": 1})]))
        await ac.post("/api/workflows/wash", json=body(script=[step(args={"duration": 2})]))

        res = await ac.get("/api/workflows/wash/versions")

    versions = res.json()["versions"]
    assert [v["version"] for v in versions] == [2, 1]
    assert versions[0]["steps"] == 1


@pytest.mark.asyncio
async def test_get_workflow_accepts_a_version_query(api_workflows_dir):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await ac.post("/api/workflows/wash", json=body(script=[step(args={"duration": 1})]))
        await ac.post("/api/workflows/wash", json=body(script=[step(args={"duration": 2})]))

        head = await ac.get("/api/workflows/wash")
        old = await ac.get("/api/workflows/wash?version=1")

    assert head.json()["script"][0]["args"]["duration"] == 2
    assert old.json()["script"][0]["args"]["duration"] == 1


@pytest.mark.asyncio
async def test_delete_refuses_while_linked(api_workflows_dir):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await ac.post("/api/workflows/wash", json=body(script=[step()]))
        await ac.post("/api/workflows/screening", json=body(script=[link("wash")]))

        blocked = await ac.delete("/api/workflows/wash")
        forced = await ac.delete("/api/workflows/wash?force=true")

    assert blocked.status_code == 409, blocked.text
    assert "screening" in blocked.json()["error"]
    assert forced.status_code == 200, forced.text


@pytest.mark.asyncio
async def test_tags_endpoint_files_a_workflow(api_workflows_dir):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await ac.post("/api/workflows/wash", json=body(script=[step()]))

        res = await ac.put("/api/workflows/wash/tags", json={"tags": ["screening", "  screening "]})
        listing = await ac.get("/api/workflows")

    assert res.json()["tags"] == ["screening"]
    by_name = {w["name"]: w for w in listing.json()["workflows"]}
    assert by_name["wash"]["tags"] == ["screening"]
    # The filter bar reads this.
    assert listing.json()["tags"] == ["screening"]


@pytest.mark.asyncio
async def test_tags_endpoint_404s_for_an_unknown_workflow(api_workflows_dir):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        res = await ac.put("/api/workflows/nope/tags", json={"tags": ["x"]})
    assert res.status_code == 404, res.text


@pytest.mark.asyncio
async def test_tags_route_is_not_shadowed_by_the_name_route(api_workflows_dir):
    """`/api/workflows/{name}/tags` must not be read as a workflow named "tags"."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await ac.post("/api/workflows/wash", json=body(script=[step()]))
        res = await ac.put("/api/workflows/wash/tags", json={"tags": []})
    assert res.status_code == 200, res.text


@pytest.mark.asyncio
async def test_list_reports_the_link_graph(api_workflows_dir):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await ac.post("/api/workflows/wash", json=body(script=[step()]))
        await ac.post("/api/workflows/screening", json=body(script=[link("wash")]))

        res = await ac.get("/api/workflows")

    by_name = {w["name"]: w for w in res.json()["workflows"]}
    assert by_name["wash"]["linked_by"] == ["screening"]
    assert by_name["screening"]["links"] == ["wash"]
    assert by_name["wash"]["version"] == 1
