#!/bin/bash
# deb postinst for autoinfluencer desktop. Replaces electron-builder's default, which picks
# 0755 for chrome-sandbox whenever `unshare --user` works as root, which it always does on
# Ubuntu 24.04+. There AppArmor (kernel.apparmor_restrict_unprivileged_userns=1) blocks user
# namespaces for ordinary users, so Chromium aborts with SIGTRAP at launch:
#   FATAL:setuid_sandbox_host.cc ... chrome-sandbox is owned by root and has mode 4755
# Fix: install an AppArmor profile granting userns (what Ubuntu ships for Chrome/Firefox),
# and fall back to a SUID chrome-sandbox when the profile cannot be loaded.

APP_DIR='/opt/autoinfluencer'
EXE="$APP_DIR/autoinfluencer-desktop"
LINK='/usr/bin/autoinfluencer-desktop'
PROFILE='/etc/apparmor.d/autoinfluencer-desktop'

if type update-alternatives >/dev/null 2>&1; then
    if [ -L "$LINK" ] && [ -e "$LINK" ] && [ "$(readlink "$LINK")" != '/etc/alternatives/autoinfluencer-desktop' ]; then
        rm -f "$LINK"
    fi
    update-alternatives --install "$LINK" 'autoinfluencer-desktop' "$EXE" 100 || ln -sf "$EXE" "$LINK"
else
    ln -sf "$EXE" "$LINK"
fi

sandbox_mode=0755
restricted=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)
if [ "$restricted" = "1" ]; then
    loaded=0
    if command -v apparmor_parser >/dev/null 2>&1 && [ -d /etc/apparmor.d ]; then
        cat > "$PROFILE" <<PROFILE_EOF
# Installed by the autoinfluencer desktop package: lets Chromium's sandbox use user namespaces.
abi <abi/4.0>,
include <tunables/global>

profile autoinfluencer-desktop $EXE flags=(unconfined) {
  userns,

  include if exists <local/autoinfluencer-desktop>
}
PROFILE_EOF
        apparmor_parser -r -T -W "$PROFILE" >/dev/null 2>&1 && loaded=1
    fi
    [ "$loaded" = "1" ] || sandbox_mode=4755
elif ! { [ -L /proc/self/ns/user ] && unshare --user true; } 2>/dev/null; then
    sandbox_mode=4755
fi
chown root:root "$APP_DIR/chrome-sandbox" 2>/dev/null || true
chmod "$sandbox_mode" "$APP_DIR/chrome-sandbox" || true

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi
if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
exit 0
