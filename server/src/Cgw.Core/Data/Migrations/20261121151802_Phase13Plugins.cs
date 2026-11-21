using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Cgw.Core.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase13Plugins : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "ApprovedHosts",
                table: "WorkspacePlugins",
                type: "varchar(4000)",
                unicode: false,
                maxLength: 4000,
                nullable: false,
                defaultValue: "[]");

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "HostsApprovedAt",
                table: "WorkspacePlugins",
                type: "datetimeoffset(3)",
                nullable: true);

            migrationBuilder.AddColumn<byte[]>(
                name: "HostsApprovedBy",
                table: "WorkspacePlugins",
                type: "binary(16)",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ApprovedHosts",
                table: "WorkspacePlugins");

            migrationBuilder.DropColumn(
                name: "HostsApprovedAt",
                table: "WorkspacePlugins");

            migrationBuilder.DropColumn(
                name: "HostsApprovedBy",
                table: "WorkspacePlugins");
        }
    }
}
