# Changelog

## 1.0.1

### Added

- AMD GPUs in the GPU card, read from the amdgpu driver

### Fixed

- Metrics now work on OPKSSH hosts
- Firewall card no longer runs sudo without a saved sudo password, which sent "a password is required" emails
- Firewall tools are run by full path so sudoers rules match

## 1.0.0

### Added

- First release
- CPU, memory, disk, network, temperature, NVIDIA GPU, processes, ports and logins
- History charts for each host
- Manage services, packages, cron jobs, firewall rules, users, SSL certificates, logs and WireGuard, with changes needing edit access on a shared host
- Health checks for your hosts and services
- A layout you can rearrange per host, and live stats in the terminal toolbar
