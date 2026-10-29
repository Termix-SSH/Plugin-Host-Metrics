<div align="center">

<img src="https://termix.site/img/logo.svg" width="120" alt="Termix Logo" />

<h1>Host Metrics</h1>

<p>Live CPU, memory, disk, network and GPU stats, plus tools to manage your hosts</p>

<!-- VIDEO:START -->

<a href="https://www.youtube.com/watch?v=_psvlU-s7D4"><img src="https://img.shields.io/badge/Watch_the_demo-f59145?style=for-the-badge&logo=youtube&logoColor=white" alt="Watch the demo on YouTube" /></a>

<!-- VIDEO:END -->

</div>

<br />

## Overview

Host Metrics shows what is happening on your servers, live and over time, and lets you manage common things on them without opening a terminal. It works over SSH on most Linux servers with nothing to install.

Read the [docs](https://docs.termix.site/plugins/host-metrics) to set it up and use it.

<br />

## Features

- CPU, memory, disk, network, temperature, NVIDIA and AMD GPUs, processes, ports and logins
- History charts for each host
- Manage services, packages, cron jobs, firewall rules, users, SSL certificates, logs and WireGuard
- Health checks for your hosts and services
- A layout you can rearrange per host
- Live stats in the terminal toolbar

<br />

### Customise the layout

Select Customise in Host Metrics to move, add or remove cards. Cards sit on a 12 column grid. Drag a card to move it: a dashed outline shows exactly where it will land, and the other cards move out of the way as you drag. Drag the left or right edge to change the width in whole columns, the bottom edge to set a fixed height, or the bottom right corner to do both. Cards below move down to make room and cards beside it never move. A height near a neighbour's bottom edge snaps to it. Press Escape to cancel a drag.

With the keyboard, focus the grip button and use the arrow keys to move a card, or focus an edge and use the arrow keys to resize it (Shift for bigger height steps, Home and End for the limits). The settings button on each card sets its width in columns, a fixed height or fit to content, and how it shows.

While customising the visible tab, use Undo and Redo, Ctrl+Z and Ctrl+Y (or Ctrl+Shift+Z) for moves, resizes, added or removed cards and resets. Text inputs and editors keep their own shortcuts. Undo history resets when switching hosts; loading saved preferences is not an undo step.

Layouts save per host through the existing preferences. Layouts from older versions are placed on the grid in their old order. Narrow screens stack cards in one column without changing the saved layout.

### Dashboard layout templates

In the **Host Metrics dashboard**, enter edit mode and open **Dashboard Templates** in the toolbar. Name and save your current layout, including cards, positions, sizes and presentation settings. Templates are private to your Termix user, with up to 50 saved templates per user.

Choose a template and review its card preview, then select accessible hosts by name or folder (up to 100 at once). **Apply to selected hosts** asks for confirmation before replacing **your** dashboard layouts on those hosts. Other users' layouts, ordinary health checks and their history, and host sampling settings are not changed. For hosts you own, the enabled widget list stays in sync with the layout for mobile clients. Failed hosts remain selected for retry; successful hosts are not reapplied on retry.

Application is a one-time copy, not inheritance. Deleting a template leaves applied layouts intact. Contributed cards appear only when their providing plugin is available. Applying to the open host replaces the active layout and edit-session baseline; Discard will not roll back that confirmed replacement.

## Sponsors

For a paid sponsor spot, email [mail@termix.site](mailto:mail@termix.site).

<!-- SPONSORS:START -->

<div align="center">

<br />

<a href="https://www.blacksmith.sh/">
  <img src="https://termix.site/img/sponsors/blacksmith.svg" height="40" alt="Blacksmith" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://www.cloudflare.com/">
  <img src="https://termix.site/img/sponsors/cloudflare.png" height="40" alt="Cloudflare" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://akamai.com/">
  <img src="https://termix.site/img/sponsors/akamai.svg" height="40" alt="Akamai" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://aws.amazon.com/">
  <img src="https://termix.site/img/sponsors/aws.png" height="40" alt="AWS" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://rackgenius.com/">
  <img src="https://termix.site/img/sponsors/rackgenius.png" height="40" alt="Rack Genius" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://ginernet.com/">
  <img src="https://termix.site/img/sponsors/ginernet.png" height="40" alt="Ginernet" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://www.hetzner.com/?mtm_campaign=termix&mtm_medium=referral&mtm_content=sponsoring_link">
  <img src="https://termix.site/img/sponsors/hetzner.png" height="40" alt="Hetzner" />
</a>

</div>

<!-- SPONSORS:END -->

<br />

## Support

Bugs and ideas for Host Metrics go in this repo: [report a bug](https://github.com/Termix-SSH/Plugin-Host-Metrics/issues/new?template=bug_report.yml) or [request a feature](https://github.com/Termix-SSH/Plugin-Host-Metrics/issues/new?template=feature_request.yml). Report an issue on the plugin's page in the Plugins tab fills in your versions for you.

Problems with Termix itself (login, hosts, credentials, sharing, sync) go in the [Termix repo](https://github.com/Termix-SSH/Termix/issues/new/choose). Not sure where it goes? Open it there and it will be moved.

Add as much detail as you can, in English if possible. For questions, join the [Discord](https://discord.gg/jVQGdvHDrf) server.

<br />

## License

Apache License 2.0. See [LICENSE](LICENSE).
