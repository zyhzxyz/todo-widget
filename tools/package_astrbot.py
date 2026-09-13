"""Build a plugin-only ZIP; never include monorepo files, credentials or journals."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
name = "astrbot_plugin_todo_widget"
source = root / "integrations" / name
files = ["__init__.py", "main.py", "core.py", "metadata.yaml", "_conf_schema.json", "requirements.txt", "README.md"]
output = root / "artifacts" / f"{name}.zip"
output.parent.mkdir(exist_ok=True)
with ZipFile(output, "w", ZIP_DEFLATED) as archive:
    for file in files:
        archive.write(source / file, f"{name}/{file}")
print(f"Plugin-only archive: {output}")
