using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Cgw.Core.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase9 : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Publishing is on by default (DECISIONS.md, 2026-11-17): every workspace already there
            // starts with it on, as a new one does (the entity's default).
            migrationBuilder.AddColumn<bool>(
                name: "PublishingEnabled",
                table: "Workspaces",
                type: "bit",
                nullable: false,
                defaultValue: true);

            // Every ticket made before 0.9.0 was for Sheet's web app.
            migrationBuilder.AddColumn<string>(
                name: "Target",
                table: "WorkbookTickets",
                type: "varchar(10)",
                unicode: false,
                maxLength: 10,
                nullable: false,
                defaultValue: "web");

            migrationBuilder.CreateTable(
                name: "PublishedSites",
                columns: table => new
                {
                    Id = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    RootPageId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Slug = table.Column<string>(type: "varchar(63)", unicode: false, maxLength: 63, nullable: false),
                    Indexing = table.Column<bool>(type: "bit", nullable: false),
                    Language = table.Column<string>(type: "varchar(10)", unicode: false, maxLength: 10, nullable: false),
                    Version = table.Column<long>(type: "bigint", nullable: false),
                    PublishedBy = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    PublishedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    UnpublishedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    UnpublishedBy = table.Column<byte[]>(type: "binary(16)", nullable: true),
                    UnpublishReason = table.Column<string>(type: "varchar(30)", unicode: false, maxLength: 30, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PublishedSites", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_PublishedSites_LiveRoot",
                table: "PublishedSites",
                column: "RootPageId",
                unique: true,
                filter: "[UnpublishedAt] IS NULL");

            migrationBuilder.CreateIndex(
                name: "IX_PublishedSites_LiveSlug",
                table: "PublishedSites",
                column: "Slug",
                unique: true,
                filter: "[UnpublishedAt] IS NULL");

            migrationBuilder.CreateIndex(
                name: "IX_PublishedSites_WorkspaceId_UnpublishedAt",
                table: "PublishedSites",
                columns: new[] { "WorkspaceId", "UnpublishedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "PublishedSites");

            migrationBuilder.DropColumn(
                name: "PublishingEnabled",
                table: "Workspaces");

            migrationBuilder.DropColumn(
                name: "Target",
                table: "WorkbookTickets");
        }
    }
}
