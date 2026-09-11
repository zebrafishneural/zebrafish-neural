# Data provenance

## Included geometry: ZAPBench

The application includes **71,721 measured cell centroids** derived from segmentation of functional imaging in ZAPBench. They are displayed as a separate geometry layer. The bundled asset contains no activity traces, connectivity, or anatomical region labels.

| Resource | Reference |
| --- | --- |
| Original centroid file | [Official JSON](https://storage.googleapis.com/zapbench-release/fluroglancer/assets/240924_dataframe_centroids.json) |
| Dataset and methods | [ZAPBench](https://zapbench-release.storage.googleapis.com/landing.html) |
| Code | [google-research/zapbench](https://github.com/google-research/zapbench) |
| License evidence | [Dataset README](https://zapbench-release.storage.googleapis.com/volumes/README.html) — CC BY 4.0 |
| Local manifest | [Coordinates, hashes, attribution, and processing](../dist/data/zapbench-centroids.metadata.json) |

The local binary `dist/data/zapbench-centroids-71721.f32` contains 860,652 bytes: interleaved `x,y,z` coordinates stored as little-endian float32 with no header. Zero-based row `i` corresponds to segmentation label `i+1`. All source positions and their ordering are retained; conversion from the source JSON to float32 reduces numerical precision.

## Coordinates

The file preserves the official Fluroglancer viewer coordinates in micrometers. The documented transformation from the native segmentation volume is:

```text
x_um =  (native_y_voxel − 664)  × 0.406
y_um = −(native_x_voxel − 1024) × 0.406
z_um =  (native_z_voxel − 36)   × 4
```

The manifest records agreement with an independently reconstructed centroid for segmentation label 1 and links the native volume metadata. Anatomical axis signs were not established by the retrieved metadata. The viewer preserves the source coordinate orientation without assigning left/right, rostral/caudal, or dorsal/ventral labels.

For display, the application subtracts the cloud's bounding-box center and scales its largest axis extent to 3.4 rendering units. This view transformation leaves the physical coordinates in the binary file unchanged.

## Relationship to the model

The eight-population model receives contrast from real browser screenshots in the shared live controller and synthetic retinal input in the controlled laboratory. It does not load the centroid file, infer connections from spatial proximity, or map model rates onto measured cells. No parameters have been fitted to biological calcium recordings.

Geometry, activity, and connectivity have independent provenance. A measured geometry layer does not establish the origin or validity of a dynamic model.

## Candidate extensions

[mapZebrain](https://mapzebrain.org/zebrafishatlas/main_page) is a candidate source for regional annotations and neuronal morphologies. No mapZebrain atlas is bundled in v0.1.

ZAPBench activity traces could support a separate recording-playback mode and later model evaluation. A comparison between calcium fluorescence and normalized model rates requires an explicit observation model, preprocessing description, and separation of fitting and evaluation data.

[FLYBRAIN](https://flybrain.online/) and [flycoinrh](https://github.com/fruitflydev/flycoinrh) provide an interaction reference. Their code and fly data files have not been copied. No cross-species equivalence of neuron labels or neurotransmitter assignments is assumed.

## Attribution

ZAPBench activity was acquired by Alex Bo-Yuan Chen in the Ahrens lab, HHMI Janelia. Segmentation annotations are credited to the CellMap Project Team, HHMI Janelia; processing, alignment, segmentation, and trace extraction to Google Research. The derivative retains the dataset's **CC BY 4.0** license, independently of the application's MIT code license. See [NOTICE](../NOTICE) and the [manifest](../dist/data/zapbench-centroids.metadata.json) for the complete provenance record.
