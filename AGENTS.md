# Remote environment

Do not forward Pi's local environment to Herdr Core. Pi and its session files stay local; remote commands use the remote environment. If a feature needs an exception, allowlist only the variables it needs, document in `README.md` why each variable is needed and safe to send, and add a test. Never forward variables by prefix (including `PI_*`).
