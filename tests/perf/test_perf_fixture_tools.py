import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
GENERATOR = ROOT / "scripts" / "generate-perf-fixture.py"
VERIFIER = ROOT / "scripts" / "verify-perf-fixture.py"


class PerfFixtureToolsTest(unittest.TestCase):
    def test_streamed_tiled_fixture_round_trip(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Path(temporary) / "small-perf.tif"
            generated = subprocess.run(
                [
                    sys.executable,
                    str(GENERATOR),
                    "--output",
                    str(fixture),
                    "--width",
                    "1024",
                    "--height",
                    "768",
                    "--tile-size",
                    "256",
                    "--compression-level",
                    "1",
                ],
                check=True,
                text=True,
                capture_output=True,
            )
            manifest = json.loads(generated.stdout)
            self.assertEqual(manifest["cellCount"], 1024 * 768)
            self.assertEqual(manifest["tileCount"], 12)
            self.assertLess(manifest["fileSizeBytes"], 1024 * 768 * 4)

            verified = subprocess.run(
                [
                    sys.executable,
                    str(VERIFIER),
                    str(fixture),
                    "--expected-width",
                    "1024",
                    "--expected-height",
                    "768",
                ],
                check=True,
                text=True,
                capture_output=True,
            )
            result = json.loads(verified.stdout)
            self.assertTrue(result["passed"])
            self.assertTrue(all(probe["matched"] for probe in result["probes"]))


if __name__ == "__main__":
    unittest.main()
