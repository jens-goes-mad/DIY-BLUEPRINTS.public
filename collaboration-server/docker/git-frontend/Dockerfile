FROM alpine:3.20

RUN apk add --no-cache cgit lighttpd git

COPY lighttpd.conf /etc/lighttpd/lighttpd.conf
COPY cgitrc /etc/cgitrc

EXPOSE 80

CMD ["lighttpd", "-D", "-f", "/etc/lighttpd/lighttpd.conf"]
