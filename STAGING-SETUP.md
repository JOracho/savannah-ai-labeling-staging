# Savannah AI Labeling: Neon staging

This document applies only to the `staging-test` branch and the Neon staging project. It does not change the live GitHub Pages site or the production Supabase project.

## Staging resources

- Git branch: `staging-test`
- Neon project: `proud-firefly-64672692`
- Neon branch: `br-calm-cherry-b973fs8j`
- Database: `savannah_staging`
- Neon Auth and Data API are enabled.
- The three private Object Storage buckets are `annotator-cvs`, `annotation-review`, and `project-deliverables`.

## Function secrets required

Set secrets in the Neon Console under the staging branch's Functions settings. Do not commit secrets or place them in browser code.

- `SUPERVISELY_API_TOKEN`: required for managed Supervisely project creation and LiDAR annotation import.
- `CVAT_API_TOKEN`: optional until the CVAT connector is tested.

The Neon Data API URL is already configured as a function environment variable. Neon Object Storage credentials are injected by the platform.

## First LiDAR test: Supervisely

1. Create a Savannah project with service type **LiDAR / 3D Point Cloud Annotation**.
2. The managed project function creates a Supervisely project with type `point_clouds`.
3. Upload a small `.pcd`, `.ply`, or other supported point-cloud sample to the Supervisely dataset.
4. Create a simple cuboid annotation and save it in Supervisely.
5. Assign the Savannah project to an annotator. The assignment should use platform `supervisely`.
6. The annotator enters the Supervisely dataset ID and point-cloud ID and submits the work from the assignment card.
7. The reviewer opens the submitted assignment in Savannah's reviewer queue. The source point-cloud file and annotation JSON are stored privately in Neon Object Storage.

The first migrated Supervisely review endpoint is focused on point-cloud submissions. The existing image annotation review path is not part of this staging test.

## CVAT

CVAT task creation and annotation review are not yet validated against Neon staging. For a manual CVAT trial, create a 3D point-cloud task in CVAT, then record the CVAT task ID, job ID, project ID, and inclusive frame range in the Savannah assignment form. Do not use the retired CVAT recovery utility.

## Deployment and verification

- GitHub Pages continues to serve the production `main` branch.
- `staging-test` is not publicly deployed yet.
- A completed Neon Function deployment means the bundle deployed; it does not prove an authenticated browser workflow works.
- Keep the temporary Supabase staging project until the Neon staging portal, auth, uploads, review, and password recovery have all passed end-to-end tests.
