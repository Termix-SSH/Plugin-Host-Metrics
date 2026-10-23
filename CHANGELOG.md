# Changelog

## 1.2.1

### Added

- Resize cards, change how each card shows, undo and redo layout changes, and save layouts as templates to apply to other hosts

### Changed

- Needs Termix 26.10.6 or newer

### Fixed

- The log viewer reads a unit when you press Enter or leave the field, instead of failing with Invalid unit while you type, and a bare name like webapp means webapp.service

## 1.2.0

### Added

- Task Manager-style, configurable CPU and memory details, including hardware, utilization history and system counts
- Physical-disk activity and per-interface network rates, histories and details, with unavailable fields identified rather than inferred
- Cached Windows hardware and static detail data to reduce repeated collection
- Smoother metric charts and respect for reduced-motion preferences

- Busiest hosts dashboard card: the hosts with the highest CPU or memory, from samples already collected
- Live CPU, memory, network and process updates every few seconds on Linux hosts, with per-core CPU bars, a memory split and a sortable, searchable process table with a tree view
- Edit, delete and default policy management in the Firewall card for UFW, iptables and nftables

### Changed

- The metrics interval setting is now called History sampling interval
- Low CPU and memory load shows in the accent colour instead of green

### Fixed

- Firewall detection picks the firewall that really owns the rules, and nftables commands use names nft accepts

## 1.1.0

### Added

- A metrics panel beside any SSH terminal with live CPU, memory, disk, temperature, uptime and the busiest processes, so you can watch a host while you work on it
- Settings for the panel: open it with new terminals, which side it sits on, its size and the edge button
- Show metrics panel in terminals, per host, in the host's Host Metrics section

## 1.0.3

### Changed

- The plugin name and description show in your language
- The METRICS_POLL_CONCURRENCY environment variable is now listed in the docs

### Fixed

- Saving metrics history failed on Postgres and MySQL once a host had moved more than 2 GB of network traffic
- Long translated labels like Festplatte made the dashboard's usage bars overlap the host status badge

## 1.0.2

### Fixed

- macOS disk gauge uses the data volume instead of the sealed system volume
- macOS disk percent now matches df instead of using the whole APFS container size

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
