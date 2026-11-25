#!/bin/bash
# deb postrm for autoinfluencer desktop: undo after-install.sh.
PROFILE='/etc/apparmor.d/autoinfluencer-desktop'

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove 'autoinfluencer-desktop' '/opt/autoinfluencer/autoinfluencer-desktop' 2>/dev/null || true
else
    rm -f '/usr/bin/autoinfluencer-desktop'
fi

case "$1" in
    remove|purge)
        if [ -f "$PROFILE" ]; then
            command -v apparmor_parser >/dev/null 2>&1 && apparmor_parser -R "$PROFILE" >/dev/null 2>&1
            rm -f "$PROFILE"
        fi
        ;;
esac
exit 0
