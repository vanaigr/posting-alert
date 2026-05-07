
```
docker build \
    --build-arg VM_HOST=10.0.0.5 \
    --build-arg VM_PORT=80 \
    -t us-central1-docker.pkg.dev/PROJECT_ID/REPO_NAME/IMAGE_NAME:TAG \
    .
```

```
gcloud auth configure-docker us-central1-docker.pkg.dev
```

```
docker push us-central1-docker.pkg.dev/PROJECT_ID/REPO_NAME/IMAGE_NAME:TAG
```

/etc/nginx/sites-available/default
```
server {
    listen 80;
    location / {
        proxy_pass http://localhost:3000;
    }
}
```
