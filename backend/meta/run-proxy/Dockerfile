FROM nginx:1.27-alpine

ARG VM_HOST
ARG VM_PORT=80
RUN test -n "$VM_HOST" || (echo "VM_HOST build arg required" && false)

ENV VM_HOST=${VM_HOST}
ENV VM_PORT=${VM_PORT}

RUN rm /etc/nginx/conf.d/default.conf

COPY <<'EOF' /etc/nginx/templates/proxy.conf.template
server {
    listen ${PORT};
    server_name _;

    resolver 169.254.169.254 valid=30s;

    location / {
        proxy_pass http://${VM_HOST}:${VM_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $http_connection;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF

ENV PORT=8080
EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
