using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Cgw.Core.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase3Offline : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<long>(
                name: "ChangesPrunedSeq",
                table: "Workspaces",
                type: "bigint",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<string>(
                name: "DocStateHash",
                table: "Pages",
                type: "varchar(64)",
                unicode: false,
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "DocStateHashSeq",
                table: "Pages",
                type: "bigint",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<int>(
                name: "ClientSchemaVersion",
                table: "PageDocUpdates",
                type: "int",
                nullable: false,
                // Rows pushed before this column were pushed by version 1 apps.
                defaultValue: 1);

            migrationBuilder.CreateIndex(
                name: "IX_WorkspaceChanges_CreatedAt",
                table: "WorkspaceChanges",
                column: "CreatedAt");

            migrationBuilder.CreateIndex(
                name: "IX_Pages_DocHeadSeq",
                table: "Pages",
                column: "DocHeadSeq",
                filter: "[DocStateHash] IS NULL AND [DeletedAt] IS NULL")
                .Annotation("SqlServer:Include", new[] { "WorkspaceId", "DocStateHashSeq" });

            migrationBuilder.CreateIndex(
                name: "IX_Pages_TrashedAt",
                table: "Pages",
                column: "TrashedAt",
                filter: "[TrashedAt] IS NOT NULL AND [DeletedAt] IS NULL")
                .Annotation("SqlServer:Include", new[] { "WorkspaceId", "TrashRootId" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_WorkspaceChanges_CreatedAt",
                table: "WorkspaceChanges");

            migrationBuilder.DropIndex(
                name: "IX_Pages_DocHeadSeq",
                table: "Pages");

            migrationBuilder.DropIndex(
                name: "IX_Pages_TrashedAt",
                table: "Pages");

            migrationBuilder.DropColumn(
                name: "ChangesPrunedSeq",
                table: "Workspaces");

            migrationBuilder.DropColumn(
                name: "DocStateHash",
                table: "Pages");

            migrationBuilder.DropColumn(
                name: "DocStateHashSeq",
                table: "Pages");

            migrationBuilder.DropColumn(
                name: "ClientSchemaVersion",
                table: "PageDocUpdates");
        }
    }
}
