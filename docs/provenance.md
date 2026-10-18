# Provenance

The package was assembled from the final six-tunnel continuous experiment and final S1 runs. The numerical engines are byte-identical to those archived with the experiments. Configuration, measurements and data-adaptation functions were moved into focused modules; their numerical outputs were checked against the archived files.

The preparation bundle retains numeric data and identity strings. Machine-specific provenance paths were replaced with relative source labels. `data/stadium/manifest.json` records both original and portable hashes. `reference/release_verification.json` records the checks performed while assembling this distribution.

OpenAI Codex and Anthropic Claude assisted with implementation, analysis and documentation during the project. The paper includes an AI-use disclosure. This cleanup removes obsolete paths, duplicate workflows and session-specific commentary while retaining the computational provenance.

The raw videos and original detection/tracking execution are not part of this package. Prepared tracking observations are the automatic reference for the stadium experiment. The source study uses Faster R-CNN with DeepSORT; no new detection or tracking is performed by these reproduction commands.

No software or data license has been added on the authors' behalf. The authors should select distribution terms before publishing the repository.
