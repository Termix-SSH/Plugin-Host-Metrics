-- SQLite integers already hold 64 bits, so nothing changes here.
UPDATE "p_host_metrics_host_metrics_history" SET "net_rx_bytes" = "net_rx_bytes" WHERE 0;
