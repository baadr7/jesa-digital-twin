#!/usr/bin/env python3
"""
JESA Digital Twin Dataset Setup Script

This script automatically downloads and organizes the datasets required for the JESA Digital Twin project.
Datasets are downloaded from public sources and extracted to the correct directory structure.
"""

import os
import zipfile
import tarfile
import urllib.request
from pathlib import Path
import sys

# Project root directory
PROJECT_ROOT = Path(__file__).parent.absolute()

# Dataset definitions
DATASETS = [
    {
        "name": "AI4I 2020 Predictive Maintenance Dataset (A1)",
        "url": "https://archive.ics.uci.edu/ml/machine-learning-databases/00601/ai4i2020.csv.zip",
        "dest_dir": PROJECT_ROOT / "ai4i+2020+predictive+maintenance+dataset",
        "filename": "ai4i2020.csv.zip",
        "extract": True,
        "post_extract": lambda dir: [f for f in dir.iterdir() if f.is_file() and f.suffix == ".csv"]
    },
    {
        "name": "Condition Monitoring of Hydraulic Systems (A2)",
        "url": "https://archive.ics.uci.edu/ml/machine-learning-databases/00447/Condition%20monitoring%20of%20hydraulic%20systems.zip",
        "dest_dir": PROJECT_ROOT / "condition+monitoring+of+hydraulic+systems",
        "filename": "Condition monitoring of hydraulic systems.zip",
        "extract": True,
    },
    {
        "name": "MetroPT-3 (A3)",
        "url": "https://www.kaggle.com/api/v1/datasets/download/viniciusmenegozzo/metropt-3",
        "dest_dir": PROJECT_ROOT / "metropt+3+dataset",
        "filename": "metropt-3.zip",
        "extract": True,
        "note": "Kaggle requires authentication - if automatic download fails, download manually from https://www.kaggle.com/datasets/viniciusmenegozzo/metropt-3"
    }
]


def download_file(url: str, dest_path: Path) -> bool:
    """Download a file from a URL to a destination path."""
    print(f"Downloading {url} to {dest_path}...")
    try:
        urllib.request.urlretrieve(url, dest_path)
        print("✓ Download complete!")
        return True
    except Exception as e:
        print(f"✗ Download failed: {e}")
        return False


def extract_archive(archive_path: Path, dest_dir: Path) -> bool:
    """Extract a zip or tar archive to a destination directory."""
    print(f"Extracting {archive_path.name} to {dest_dir}...")
    try:
        if archive_path.suffix == ".zip":
            with zipfile.ZipFile(archive_path, "r") as zip_ref:
                zip_ref.extractall(dest_dir)
        elif archive_path.suffix in [".tar", ".tar.gz", ".tgz"]:
            with tarfile.open(archive_path, "r:*") as tar_ref:
                tar_ref.extractall(dest_dir)
        else:
            print(f"✗ Unsupported archive format: {archive_path.suffix}")
            return False
        print("✓ Extraction complete!")
        return True
    except Exception as e:
        print(f"✗ Extraction failed: {e}")
        return False


def main():
    print("=" * 70)
    print("JESA Digital Twin Dataset Setup Script")
    print("=" * 70)
    print()

    for dataset in DATASETS:
        print(f"Processing: {dataset['name']}")
        print("-" * 70)

        # Create destination directory if it doesn't exist
        dest_dir = dataset["dest_dir"]
        dest_dir.mkdir(parents=True, exist_ok=True)

        # Check if dataset already exists
        csv_files = list(dest_dir.glob("*.csv"))
        if len(csv_files) > 0 or any(dest_dir.iterdir()):
            print(f"✓ Dataset already exists at {dest_dir}")
            print()
            continue

        # Download the dataset
        archive_path = dest_dir / dataset["filename"]
        if not download_file(dataset["url"], archive_path):
            if "note" in dataset:
                print(f"\nNote: {dataset['note']}")
            print()
            continue

        # Extract if needed
        if dataset["extract"]:
            if not extract_archive(archive_path, dest_dir):
                print()
                continue

        print()

    print("=" * 70)
    print("Setup complete! You can now run the project with launch_all.ps1 or launch_all.bat!")
    print("=" * 70)


if __name__ == "__main__":
    main()
