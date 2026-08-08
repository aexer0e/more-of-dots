from __future__ import annotations

import argparse
import json
from pathlib import Path

from .version_vault import SupportedVersionCatalog, VersionVault


def main() -> None:
    parser = argparse.ArgumentParser(description="Create the recorder's single-build bundled version vault.")
    parser.add_argument("--source-home", required=True, type=Path)
    parser.add_argument("--destination-home", required=True, type=Path)
    args = parser.parse_args()

    catalog = SupportedVersionCatalog()
    source = VersionVault(args.source_home, catalog)
    destination = VersionVault(args.destination_home, catalog)
    exported = []
    for version in catalog.versions:
        metadata = source.read_metadata(version)
        if metadata is None:
            raise RuntimeError(f"Required bundled game version {version} was not found in {source.home}.")
        build = catalog.lookup(version)
        if build is None:
            raise RuntimeError(f"Required bundled game version {version} is missing from the catalog.")
        exported.append(
            destination.import_build(
                version,
                Path(metadata["path"]),
                source="bundled",
                supported_build=build,
            )
        )
    print(json.dumps({"versions": [item["game_version"] for item in exported]}))


if __name__ == "__main__":
    main()
