using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Cgw.Core.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase16Forms : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<byte[]>(
                name: "FormId",
                table: "Pages",
                type: "binary(16)",
                nullable: true);

            migrationBuilder.AddColumn<byte[]>(
                name: "FormId",
                table: "AutomationEvents",
                type: "binary(16)",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "FormLinks",
                columns: table => new
                {
                    Id = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    DatabaseId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    ViewId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    TokenHash = table.Column<byte[]>(type: "varbinary(32)", maxLength: 32, nullable: false),
                    TokenCipher = table.Column<string>(type: "varchar(4000)", unicode: false, maxLength: 4000, nullable: false),
                    Enabled = table.Column<bool>(type: "bit", nullable: false),
                    ClosesAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    MaxAnswers = table.Column<int>(type: "int", nullable: true),
                    Answers = table.Column<int>(type: "int", nullable: false),
                    CreatedBy = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    Version = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_FormLinks", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_Pages_Form",
                table: "Pages",
                column: "FormId",
                filter: "[FormId] IS NOT NULL")
                .Annotation("SqlServer:Include", new[] { "Kind", "DeletedAt", "TrashedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_FormLinks_DatabaseId",
                table: "FormLinks",
                column: "DatabaseId");

            migrationBuilder.CreateIndex(
                name: "IX_FormLinks_TokenHash",
                table: "FormLinks",
                column: "TokenHash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_FormLinks_ViewId",
                table: "FormLinks",
                column: "ViewId",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "FormLinks");

            migrationBuilder.DropIndex(
                name: "IX_Pages_Form",
                table: "Pages");

            migrationBuilder.DropColumn(
                name: "FormId",
                table: "Pages");

            migrationBuilder.DropColumn(
                name: "FormId",
                table: "AutomationEvents");
        }
    }
}
