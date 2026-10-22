"""Read-only Linux/UFW 0.36.2 regression; pass the exported UFW_PROBE script path."""

import contextlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
from unittest.mock import patch


probe = pathlib.Path(sys.argv[1]).read_text()
read_text = pathlib.Path.read_text


def run(extra="", family="user.rules"):
    def changed(path, *args, **kwargs):
        text = read_text(path, *args, **kwargs)
        if str(path) == "/etc/ufw/" + family:
            text = text.replace("\nCOMMIT", "\n" + extra + "\nCOMMIT", 1)
        return text

    output = io.StringIO()
    with patch.object(pathlib.Path, "read_text", changed):
        with contextlib.redirect_stdout(output):
            exec(compile(probe, "<UFW_PROBE>", "exec"), {})
    return json.loads(output.getvalue())


baseline = run()
assert baseline["canonical"], "Baseline must be a canonical generated UFW file"
for family in ["user.rules"] + (["user6.rules"] if baseline["ipv6"] else []):
    prefix = "ufw6" if family == "user6.rules" else "ufw"
    source = "2001:db8::/32" if family == "user6.rules" else "192.0.2.0/24"
    for extra in [
        f" -A {prefix}-user-input -s {source} -j DROP",
        f"\t-A {prefix}-user-input -s {source} -j DROP",
        "unexpected restore content",
        "*nat",
    ]:
        result = run(extra, family)
        assert not result["canonical"], (family, extra)
        assert result["rows"] == baseline["rows"], "Parser metadata must stay unchanged"
        print("PASS rejected", family, repr(extra))

assert run("  # harmless comment")["canonical"]
print("PASS harmless indented comments remain canonical")

with tempfile.TemporaryDirectory(prefix="hm-untrusted-") as directory:
    pathlib.Path(directory, "json.py").write_text(
        "raise RuntimeError('untrusted Python import executed')"
    )
    child = subprocess.run(
        ["/usr/bin/python3", "-I", "-B", "-c", probe],
        cwd=directory,
        env={**os.environ, "PYTHONPATH": directory},
        capture_output=True,
        text=True,
        check=True,
    )
    assert json.loads(child.stdout)["canonical"]
    assert not child.stderr, child.stderr
print("PASS isolated probe ignores untrusted working directory and PYTHONPATH")
