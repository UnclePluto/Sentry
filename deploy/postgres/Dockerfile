FROM postgres:17-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends pgbackrest python3 && rm -rf /var/lib/apt/lists/*
COPY backup.py /usr/local/bin/sentry-pgbackrest
COPY schedule.py /usr/local/bin/sentry-pgbackrest-schedule
COPY init.sh /docker-entrypoint-initdb.d/10-sentry.sh
RUN chmod 755 /usr/local/bin/sentry-pgbackrest /usr/local/bin/sentry-pgbackrest-schedule && mkdir -p /var/log/pgbackrest /var/spool/pgbackrest && chown postgres:postgres /var/log/pgbackrest /var/spool/pgbackrest
