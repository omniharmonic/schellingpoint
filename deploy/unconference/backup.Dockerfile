FROM postgres:16-alpine
RUN apk add --no-cache age aws-cli sqlite tar gzip
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh
ENTRYPOINT ["/usr/local/bin/backup.sh", "--loop"]
