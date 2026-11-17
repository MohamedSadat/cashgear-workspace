using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Cgw.Core.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase10 : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // The worker's own calls (embed) have no person.
            migrationBuilder.AlterColumn<byte[]>(
                name: "UserId",
                table: "AiUsage",
                type: "binary(16)",
                nullable: true,
                oldClrType: typeof(byte[]),
                oldType: "binary(16)");

            migrationBuilder.AddColumn<bool>(
                name: "EmbeddingsEnabled",
                table: "AiSettings",
                type: "bit",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<long>(
                name: "EmbeddingsGeneration",
                table: "AiSettings",
                type: "bigint",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<string>(
                name: "EmbeddingsKeyCipher",
                table: "AiSettings",
                type: "varchar(4000)",
                unicode: false,
                maxLength: 4000,
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "EmbeddingsKeySetAt",
                table: "AiSettings",
                type: "datetimeoffset(3)",
                nullable: true);

            migrationBuilder.AddColumn<byte[]>(
                name: "EmbeddingsKeySetBy",
                table: "AiSettings",
                type: "binary(16)",
                nullable: true);

            // Every workspace already there starts with embeddings off, Voyage's voyage-4 named
            // (DECISIONS.md, 2026-11-18), as a new row does (the entity's defaults).
            migrationBuilder.AddColumn<string>(
                name: "EmbeddingsModel",
                table: "AiSettings",
                type: "varchar(64)",
                unicode: false,
                maxLength: 64,
                nullable: false,
                defaultValue: "voyage-4");

            migrationBuilder.AddColumn<string>(
                name: "EmbeddingsProvider",
                table: "AiSettings",
                type: "varchar(20)",
                unicode: false,
                maxLength: 20,
                nullable: false,
                defaultValue: "voyage");

            migrationBuilder.CreateTable(
                name: "EmbeddingChanges",
                columns: table => new
                {
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Seq = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    PageId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_EmbeddingChanges", x => new { x.WorkspaceId, x.Seq });
                });

            migrationBuilder.CreateTable(
                name: "PageEmbeddings",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    PageId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Chunk = table.Column<int>(type: "int", nullable: false),
                    Model = table.Column<string>(type: "varchar(64)", unicode: false, maxLength: 64, nullable: false),
                    TextHash = table.Column<byte[]>(type: "varbinary(32)", maxLength: 32, nullable: false),
                    Vector = table.Column<byte[]>(type: "varbinary(1024)", maxLength: 1024, nullable: false),
                    TextVersion = table.Column<long>(type: "bigint", nullable: false),
                    PageVersion = table.Column<long>(type: "bigint", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PageEmbeddings", x => x.Id)
                        .Annotation("SqlServer:Clustered", false);
                });

            migrationBuilder.CreateTable(
                name: "PluginFrameTickets",
                columns: table => new
                {
                    Id = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    PluginId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    BundleHash = table.Column<string>(type: "varchar(64)", unicode: false, maxLength: 64, nullable: false),
                    TokenHash = table.Column<byte[]>(type: "varbinary(32)", maxLength: 32, nullable: false),
                    ExpiresAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    CreatedBy = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PluginFrameTickets", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "WorkspacePlugins",
                columns: table => new
                {
                    Id = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Type = table.Column<string>(type: "varchar(64)", unicode: false, maxLength: 64, nullable: false),
                    Version = table.Column<int>(type: "int", nullable: false),
                    Manifest = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    Files = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    BundleHash = table.Column<string>(type: "varchar(64)", unicode: false, maxLength: 64, nullable: false),
                    BlobPrefix = table.Column<string>(type: "varchar(300)", unicode: false, maxLength: 300, nullable: false),
                    SizeBytes = table.Column<long>(type: "bigint", nullable: false),
                    Enabled = table.Column<bool>(type: "bit", nullable: false),
                    AddedBy = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    AddedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    UpdatedBy = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    RemovedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    RemovedBy = table.Column<byte[]>(type: "binary(16)", nullable: true),
                    BlobsDeletedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WorkspacePlugins", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AiSettings_Embeddings",
                table: "AiSettings",
                column: "EmbeddingsEnabled",
                filter: "[EmbeddingsEnabled] = 1");

            migrationBuilder.CreateIndex(
                name: "IX_EmbeddingChanges_CreatedAt",
                table: "EmbeddingChanges",
                column: "CreatedAt");

            migrationBuilder.CreateIndex(
                name: "IX_PageEmbeddings_Page",
                table: "PageEmbeddings",
                columns: new[] { "WorkspaceId", "PageId", "Model", "Chunk" },
                unique: true)
                .Annotation("SqlServer:Clustered", true);

            migrationBuilder.CreateIndex(
                name: "IX_PluginFrameTickets_ExpiresAt",
                table: "PluginFrameTickets",
                column: "ExpiresAt");

            migrationBuilder.CreateIndex(
                name: "IX_PluginFrameTickets_TokenHash",
                table: "PluginFrameTickets",
                column: "TokenHash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_WorkspacePlugins_LiveType",
                table: "WorkspacePlugins",
                columns: new[] { "WorkspaceId", "Type" },
                unique: true,
                filter: "[RemovedAt] IS NULL");

            migrationBuilder.CreateIndex(
                name: "IX_WorkspacePlugins_Removed",
                table: "WorkspacePlugins",
                column: "RemovedAt",
                filter: "[RemovedAt] IS NOT NULL AND [BlobsDeletedAt] IS NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "EmbeddingChanges");

            migrationBuilder.DropTable(
                name: "PageEmbeddings");

            migrationBuilder.DropTable(
                name: "PluginFrameTickets");

            migrationBuilder.DropTable(
                name: "WorkspacePlugins");

            migrationBuilder.DropIndex(
                name: "IX_AiSettings_Embeddings",
                table: "AiSettings");

            migrationBuilder.DropColumn(
                name: "EmbeddingsEnabled",
                table: "AiSettings");

            migrationBuilder.DropColumn(
                name: "EmbeddingsGeneration",
                table: "AiSettings");

            migrationBuilder.DropColumn(
                name: "EmbeddingsKeyCipher",
                table: "AiSettings");

            migrationBuilder.DropColumn(
                name: "EmbeddingsKeySetAt",
                table: "AiSettings");

            migrationBuilder.DropColumn(
                name: "EmbeddingsKeySetBy",
                table: "AiSettings");

            migrationBuilder.DropColumn(
                name: "EmbeddingsModel",
                table: "AiSettings");

            migrationBuilder.DropColumn(
                name: "EmbeddingsProvider",
                table: "AiSettings");

            migrationBuilder.AlterColumn<byte[]>(
                name: "UserId",
                table: "AiUsage",
                type: "binary(16)",
                nullable: false,
                defaultValue: new byte[0],
                oldClrType: typeof(byte[]),
                oldType: "binary(16)",
                oldNullable: true);
        }
    }
}
