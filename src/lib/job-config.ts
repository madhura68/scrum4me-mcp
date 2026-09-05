// M39: dit bestand is een shim — de canonieke module is scrum4me-shared
// (het M16-TODO hierboven stond sinds de platform-split open; de-drift zie
// docs/plans/M39-opus-5-model-config.md §1.3 in de Scrum4Me-repo).
// De '@shared'-alias resolvet óók in de docker-runner: de image zet
// TSX_TSCONFIG_PATH=/opt/scrum4me-mcp/tsconfig.json (scrum4me-docker
// Dockerfile r134) en wait-for-job.ts importeert al jaren top-level uit
// '@shared/job-config.js' in het runner-importpad.
export * from '@shared/job-config.js'
