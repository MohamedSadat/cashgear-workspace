using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Cgw.Core.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase14RowFiles : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "DatabaseRowFiles",
                columns: table => new
                {
                    RowId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    PropertyId = table.Column<string>(type: "varchar(16)", unicode: false, maxLength: 16, nullable: false),
                    AssetId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    DatabaseId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DatabaseRowFiles", x => new { x.RowId, x.PropertyId, x.AssetId });
                });

            migrationBuilder.CreateIndex(
                name: "IX_DatabaseRowFiles_AssetId",
                table: "DatabaseRowFiles",
                column: "AssetId")
                .Annotation("SqlServer:Include", new[] { "WorkspaceId", "DatabaseId" });

            migrationBuilder.CreateIndex(
                name: "IX_DatabaseRowFiles_DatabaseId_PropertyId",
                table: "DatabaseRowFiles",
                columns: new[] { "DatabaseId", "PropertyId" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "DatabaseRowFiles");
        }
    }
}
