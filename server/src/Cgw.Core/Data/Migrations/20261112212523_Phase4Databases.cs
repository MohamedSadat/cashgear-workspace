using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Cgw.Core.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase4Databases : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "DatabaseRows",
                columns: table => new
                {
                    PageId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    DatabaseId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Values = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    PropertyVersions = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    Computed = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    ComputedVersion = table.Column<long>(type: "bigint", nullable: true),
                    Seq = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DatabaseRows", x => x.PageId);
                });

            migrationBuilder.CreateTable(
                name: "Databases",
                columns: table => new
                {
                    PageId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Properties = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    Version = table.Column<long>(type: "bigint", nullable: false),
                    RowCount = table.Column<long>(type: "bigint", nullable: false),
                    RowsVersion = table.Column<long>(type: "bigint", nullable: false),
                    ComputePending = table.Column<bool>(type: "bit", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Databases", x => x.PageId);
                });

            migrationBuilder.CreateTable(
                name: "DatabaseViews",
                columns: table => new
                {
                    Id = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    DatabaseId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Name = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    Type = table.Column<string>(type: "nvarchar(20)", maxLength: 20, nullable: false),
                    OrderKey = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false, collation: "Latin1_General_100_BIN2"),
                    Config = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    Version = table.Column<long>(type: "bigint", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DatabaseViews", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_Pages_Tree",
                table: "Pages",
                column: "WorkspaceId",
                filter: "[Kind] <> N'row' AND [DeletedAt] IS NULL")
                .Annotation("SqlServer:Include", new[] { "ParentPageId", "SectionId", "Restricted" });

            migrationBuilder.CreateIndex(
                name: "IX_DatabaseRows_DatabaseId_PageId",
                table: "DatabaseRows",
                columns: new[] { "DatabaseId", "PageId" });

            migrationBuilder.CreateIndex(
                name: "IX_DatabaseRows_DatabaseId_Seq",
                table: "DatabaseRows",
                columns: new[] { "DatabaseId", "Seq" });

            migrationBuilder.CreateIndex(
                name: "IX_Databases_ComputePending",
                table: "Databases",
                column: "ComputePending",
                filter: "[ComputePending] = 1")
                .Annotation("SqlServer:Include", new[] { "WorkspaceId" });

            migrationBuilder.CreateIndex(
                name: "IX_Databases_WorkspaceId",
                table: "Databases",
                column: "WorkspaceId");

            migrationBuilder.CreateIndex(
                name: "IX_DatabaseViews_WorkspaceId_DatabaseId",
                table: "DatabaseViews",
                columns: new[] { "WorkspaceId", "DatabaseId" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "DatabaseRows");

            migrationBuilder.DropTable(
                name: "Databases");

            migrationBuilder.DropTable(
                name: "DatabaseViews");

            migrationBuilder.DropIndex(
                name: "IX_Pages_Tree",
                table: "Pages");
        }
    }
}
