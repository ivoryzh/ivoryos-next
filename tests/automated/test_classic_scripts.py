"""Scripts written for IvoryOS Classic (`import ivoryos`), turned into ones NextGen runs (classic.py).

Each edit keeps the original line commented out above the new one, so going back is uncommenting;
what NextGen cannot carry over is said in the notes rather than guessed at. The shapes below are
the ones real Classic scripts use (`port`, `config=DemoConfig()`, `blueprint_plugins`, `logger`).
"""
import ast
import json
import logging
import sys

from ivoryos_edge.classic import convert, is_classic, main

CLASSIC = '''import time
from ivoryos.config import DemoConfig
from shop_web.plugin import shop_bp


class Pump:
    def pump(self, ml: float):
        return ml


pump = Pump()

if __name__ == "__main__":
    import ivoryos
    ivoryos.run(__name__, port=7860, config=DemoConfig(),
                blueprint_plugins=[shop_bp], logger="pump")
'''


def test_a_classic_script_is_recognised_and_a_nextgen_one_is_not():
    assert is_classic(CLASSIC)
    assert not is_classic("import ivoryos_edge\nivoryos_edge.run(__name__)\n")
    assert not is_classic("import ivoryos_tools\n")
    assert is_classic("from ivoryos import block\n")
    assert not is_classic(convert(CLASSIC)["converted"].replace("from ivoryos.config", "# x"))


def test_the_import_and_the_run_call_switch_over_with_the_originals_kept_as_comments():
    result = convert(CLASSIC)
    out = result["converted"]
    ast.parse(out)
    assert "    # import ivoryos  # IvoryOS Classic\n    import ivoryos_edge as ivoryos  # IvoryOS NextGen\n" in out
    # port and logger are NextGen's too; config and the Flask pages are not.
    assert "    ivoryos.run(__name__, port=7860, logger=\"pump\")  # IvoryOS NextGen\n" in out
    assert "    # ivoryos.run(__name__, port=7860, config=DemoConfig(),  # IvoryOS Classic\n" in out
    assert "    #             blueprint_plugins=[shop_bp], logger=\"pump\")  # IvoryOS Classic\n" in out
    # Imports only the left-out arguments needed, so the script does not stop on them.
    assert "# from ivoryos.config import DemoConfig  # IvoryOS Classic\n" in out
    assert "# from shop_web.plugin import shop_bp  # IvoryOS Classic\n" in out
    assert "import time\n" in out and "pump = Pump()\n" in out
    notes = " ".join(result["notes"])
    assert "config left out" in notes and "blueprint_plugins left out" in notes and "docs/plugins.md" in notes
    assert [c["line"] for c in result["changes"]] == [2, 3, 14, 15]


def test_going_back_is_uncommenting_the_classic_lines():
    out = convert(CLASSIC)["converted"].splitlines(keepends=True)
    back = []
    for line in out:
        if line.rstrip().endswith("# IvoryOS NextGen"):
            continue
        if line.rstrip().endswith("# IvoryOS Classic"):
            indent = line[: len(line) - len(line.lstrip())]
            line = indent + line.strip()[2:].replace("  # IvoryOS Classic", "") + "\n"
        back.append(line)
    assert "".join(back) == CLASSIC


def test_what_nextgen_has_no_counterpart_for_is_named_not_changed():
    source = "import ivoryos\nfrom ivoryos.config import DemoConfig\ncfg = DemoConfig()\n\n@ivoryos.block\ndef step():\n    pass\n\nivoryos.run(__name__)\n"
    result = convert(source)
    notes = " ".join(result["notes"])
    assert "DemoConfig is still used elsewhere" in notes  # its import is left for the person
    assert "ivoryos.block is from Classic" in notes
    assert "from ivoryos.config import DemoConfig\n" in result["converted"]
    assert "ivoryos.run(__name__)\n" in result["converted"]  # nothing to leave out: unchanged


def test_a_script_that_does_not_parse_is_left_alone():
    result = convert("import ivoryos\nivoryos.run(__name__\n")
    assert result["classic"] is False and "could not be read" in result["notes"][0]


def test_the_command_line_prints_json_and_writes_only_when_asked(tmp_path, capsys):
    script = tmp_path / "bench.py"
    script.write_text(CLASSIC)
    assert main([str(script)]) == 0
    printed = json.loads(capsys.readouterr().out)
    assert printed["classic"] and script.read_text() == CLASSIC
    assert main([str(script), "--write"]) == 0
    capsys.readouterr()
    assert "import ivoryos_edge as ivoryos" in script.read_text()


def test_run_logger_sends_those_loggers_to_the_output_once(capsys):
    from ivoryos_edge.server import _echo_loggers
    _echo_loggers("classic.test.pump")
    _echo_loggers(["classic.test.pump"])
    log = logging.getLogger("classic.test.pump")
    assert sum(1 for h in log.handlers if getattr(h, "_ivoryos_echo", False)) == 1
    assert log.level == logging.INFO
    handler = next(h for h in log.handlers if getattr(h, "_ivoryos_echo", False))
    handler.stream = sys.stdout  # capsys swaps stdout after the handler was made
    muted = logging.root.manager.disable  # test_ax_batches.py turns logging off for Ax's chatter
    logging.disable(logging.NOTSET)
    try:
        log.info("dispensed 2 mL")
    finally:
        logging.disable(muted)
    assert "classic.test.pump INFO: dispensed 2 mL" in capsys.readouterr().out


def test_exclude_names_carries_over():
    # NextGen's run() takes it: the script's own objects that are not instruments stay off the deck.
    source = ("import ivoryos\nfrom ivoryos.config import DemoConfig\n"
              "ivoryos.run(__name__, config=DemoConfig(), exclude_names=[\"settings\"])\n")
    result = convert(source)
    assert 'ivoryos.run(__name__, exclude_names=["settings"])  # IvoryOS NextGen\n' in result["converted"]
    assert not any("exclude_names" in note for note in result["notes"])
