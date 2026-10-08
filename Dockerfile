FROM ollama/ollama:latest

RUN apt-get update && \
    apt-get install -y --no-install-recommends nginx python3 python3-psycopg2 && \
    rm -rf /var/lib/apt/lists/*

COPY ui/index.html ui/style.css ui/app.js /usr/share/nginx/html/
COPY docker/nginx.conf /etc/nginx/sites-enabled/default
COPY docker/proxy.py /usr/local/bin/proxy.py
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /usr/local/bin/proxy.py

EXPOSE 11434 80

ENTRYPOINT ["/entrypoint.sh"]
