# SQL Server 2022 with full-text search, for the server tests in CI (Q7: the search uses
# full-text when the server has it). The official image has no full-text package; Microsoft's
# own samples add it like this.
FROM mcr.microsoft.com/mssql/server:2022-latest
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl gnupg ca-certificates \
    && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | apt-key add - \
    && curl -fsSL https://packages.microsoft.com/config/ubuntu/22.04/mssql-server-2022.list -o /etc/apt/sources.list.d/mssql-server-2022.list \
    && apt-get update \
    && apt-get install -y mssql-server-fts \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
USER mssql
