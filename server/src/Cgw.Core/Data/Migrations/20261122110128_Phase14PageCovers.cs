using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Cgw.Core.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase14PageCovers : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "IX_Pages_Cover",
                table: "Pages",
                column: "CoverAssetId",
                filter: "[CoverAssetId] IS NOT NULL")
                .Annotation("SqlServer:Include", new[] { "WorkspaceId", "Kind", "ParentPageId", "DeletedAt", "TrashedAt", "IsTemplate" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Pages_Cover",
                table: "Pages");
        }
    }
}
