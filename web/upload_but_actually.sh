#!/bin/sh

gcloud storage cp -r dist/* gs://aboba52_jobalert_bot-app/

# Thanks, GCP. Obviously when you upload the file you need to delete its entire
# metadata. And obviously when uploading files, I can't specify that THIS SPECIFIC
# FILE NEEDS A DIFFERENT METADATA
# Also, great decision to CACHE HTML FILES. I guess I need to make new pages
# every time yes?? Or have some system that decides which unique html prefix
# is the current one for the page?? Or maybe it just should not cache HTML
# files...
gcloud storage cp ./dist/index.html gs://aboba52_jobalert_bot-app/index.html \
  --cache-control="public, max-age=3600"
