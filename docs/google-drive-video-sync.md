# Google Drive video sync

This optional integration uses the configured Google Drive folder as a source inbox, generates YouTube metadata with the configured OpenAI/Gemini text provider, uploads the video, then moves the Drive file into a child folder named `Uploaded`.

## Important behavior

- Enable it only after verifying the folder contents. When enabled, every supported video file directly inside the configured parent folder is eligible for upload. Do not leave unrelated videos in that folder.
- The service creates an `Uploaded` subfolder automatically. Files in that subfolder are not scanned again.
- The default delay is 30 minutes. The YouTube upload is created as private with a scheduled publish time; YouTube is expected to make it public at that time. Set `DRIVE_PUBLISH_DELAY_MINUTES=0` to upload privately without a publish time.
- Metadata is generated from the filename, not visual analysis of the video. Review generated metadata and YouTube scheduling before relying on unattended publishing.
- An `uploading` marker is written to Drive before the upload call. If the network outcome is uncertain, the file is intentionally left in the source folder and skipped on later polls to avoid duplicate uploads. Reconcile the YouTube channel manually before resetting that marker.
- The app moves a file only after YouTube returns a video ID. If moving fails after upload, Drive app properties retain the YouTube ID so the file will not be uploaded twice.
- This does not bypass the app's normal review gates for the separate AI-generation workflow; Drive inbox uploads are a distinct opt-in workflow.

## Setup

1. In Google Cloud Console, enable **Google Drive API** for a service account. Download its JSON credentials.
2. Share the existing Drive folder with the service account's email address and grant **Editor** access.
3. Add the following values to the host's environment/secrets. Never commit the service-account JSON to GitHub:

   ```dotenv
   DRIVE_SYNC_ENABLED=true
   DRIVE_FOLDER_ID=1PVOAlPtbJXLsS0L8J-cULdVGXr2B-ih5
   DRIVE_POLL_INTERVAL_SECONDS=300
   DRIVE_PUBLISH_DELAY_MINUTES=30
   GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE=/absolute/path/to/service-account.json
   ```

   Alternatively, set `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON` to the service-account JSON as a secret instead of using the file path.

4. Configure YouTube OAuth and at least one working text provider (OpenAI or Gemini) using the existing app setup.
5. Restart the service. Check `GET /api/drive-sync/status` using the configured `x-api-key` header. Logs report permission or initialization errors.
6. Move only the videos you intend to process into the configured parent folder. After successful upload, each file is moved into `Uploaded` and its Drive app properties record the YouTube video ID and URL.

## Duplicate recovery

Files with `youtubeAutomationStatus=uploading` are deliberately not retried automatically because YouTube may have accepted the upload before a network error. Confirm whether the video exists on the connected YouTube channel first. If it does, record the YouTube video ID in the Drive file's app properties and move it into `Uploaded`; only clear the in-progress marker if you have verified that no upload occurred.
