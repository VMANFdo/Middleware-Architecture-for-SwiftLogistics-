FROM nginx:alpine

COPY index.html app.js styles.css manifest.json sw.js icon-192.png icon-512.png /usr/share/nginx/html/
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
