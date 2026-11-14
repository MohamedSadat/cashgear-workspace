using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Cgw.Core.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase5Workbooks : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ErpLinks",
                columns: table => new
                {
                    Id = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    ErpLinkId = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: false),
                    ErpBaseUrl = table.Column<string>(type: "nvarchar(300)", maxLength: 300, nullable: false),
                    Company = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: false),
                    CompanyName = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    LinkedBy = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    LinkedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    RevokedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    RevokedBy = table.Column<byte[]>(type: "binary(16)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ErpLinks", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "FileSessions",
                columns: table => new
                {
                    Id = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    UserId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkbookId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Access = table.Column<string>(type: "nvarchar(10)", maxLength: 10, nullable: false),
                    TokenHash = table.Column<byte[]>(type: "varbinary(32)", maxLength: 32, nullable: false),
                    Language = table.Column<string>(type: "nvarchar(10)", maxLength: 10, nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    IdleExpiresAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    MaxExpiresAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    EndedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    Renews = table.Column<int>(type: "int", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_FileSessions", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "WorkbookPermissions",
                columns: table => new
                {
                    WorkbookId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    PrincipalType = table.Column<string>(type: "nvarchar(20)", maxLength: 20, nullable: false),
                    PrincipalId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Level = table.Column<string>(type: "nvarchar(20)", maxLength: 20, nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    CreatedBy = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WorkbookPermissions", x => new { x.WorkbookId, x.PrincipalType, x.PrincipalId });
                });

            migrationBuilder.CreateTable(
                name: "WorkbookPreviews",
                columns: table => new
                {
                    WorkbookId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    VersionId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    ViewHash = table.Column<string>(type: "varchar(64)", unicode: false, maxLength: 64, nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    BlobKey = table.Column<string>(type: "nvarchar(300)", maxLength: 300, nullable: false),
                    Width = table.Column<int>(type: "int", nullable: false),
                    Height = table.Column<int>(type: "int", nullable: false),
                    SizeBytes = table.Column<long>(type: "bigint", nullable: false),
                    MadeBy = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    MadeAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WorkbookPreviews", x => new { x.WorkbookId, x.VersionId, x.ViewHash });
                });

            migrationBuilder.CreateTable(
                name: "Workbooks",
                columns: table => new
                {
                    Id = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Name = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    SearchName = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    CurrentVersionId = table.Column<byte[]>(type: "binary(16)", nullable: true),
                    Restricted = table.Column<bool>(type: "bit", nullable: false),
                    Version = table.Column<long>(type: "bigint", nullable: false),
                    CreatedBy = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    TrashedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    TrashedBy = table.Column<byte[]>(type: "binary(16)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Workbooks", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "WorkbookTickets",
                columns: table => new
                {
                    Id = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkbookId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    UserId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Access = table.Column<string>(type: "nvarchar(10)", maxLength: 10, nullable: false),
                    TokenHash = table.Column<byte[]>(type: "varbinary(32)", maxLength: 32, nullable: false),
                    ExpiresAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    UsedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WorkbookTickets", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "WorkbookVersions",
                columns: table => new
                {
                    Id = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkbookId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    BlobKey = table.Column<string>(type: "nvarchar(300)", maxLength: 300, nullable: false),
                    SizeBytes = table.Column<long>(type: "bigint", nullable: false),
                    Sha256 = table.Column<string>(type: "varchar(64)", unicode: false, maxLength: 64, nullable: false),
                    SavedBy = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    SavedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WorkbookVersions", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ErpLinks_WorkspaceId",
                table: "ErpLinks",
                column: "WorkspaceId");

            migrationBuilder.CreateIndex(
                name: "IX_ErpLinks_WorkspaceId_ErpBaseUrl_Company",
                table: "ErpLinks",
                columns: new[] { "WorkspaceId", "ErpBaseUrl", "Company" },
                unique: true,
                filter: "[RevokedAt] IS NULL");

            migrationBuilder.CreateIndex(
                name: "IX_FileSessions_MaxExpiresAt",
                table: "FileSessions",
                column: "MaxExpiresAt");

            migrationBuilder.CreateIndex(
                name: "IX_FileSessions_TokenHash",
                table: "FileSessions",
                column: "TokenHash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_FileSessions_WorkspaceId_UserId",
                table: "FileSessions",
                columns: new[] { "WorkspaceId", "UserId" });

            migrationBuilder.CreateIndex(
                name: "IX_WorkbookPermissions_WorkspaceId_PrincipalId",
                table: "WorkbookPermissions",
                columns: new[] { "WorkspaceId", "PrincipalId" });

            migrationBuilder.CreateIndex(
                name: "IX_WorkbookPreviews_WorkbookId_ViewHash_MadeAt",
                table: "WorkbookPreviews",
                columns: new[] { "WorkbookId", "ViewHash", "MadeAt" });

            migrationBuilder.CreateIndex(
                name: "IX_Workbooks_TrashedAt",
                table: "Workbooks",
                column: "TrashedAt",
                filter: "[TrashedAt] IS NOT NULL")
                .Annotation("SqlServer:Include", new[] { "WorkspaceId" });

            migrationBuilder.CreateIndex(
                name: "IX_Workbooks_WorkspaceId_TrashedAt_UpdatedAt",
                table: "Workbooks",
                columns: new[] { "WorkspaceId", "TrashedAt", "UpdatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_WorkbookTickets_ExpiresAt",
                table: "WorkbookTickets",
                column: "ExpiresAt");

            migrationBuilder.CreateIndex(
                name: "IX_WorkbookTickets_TokenHash",
                table: "WorkbookTickets",
                column: "TokenHash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_WorkbookVersions_WorkbookId_SavedAt",
                table: "WorkbookVersions",
                columns: new[] { "WorkbookId", "SavedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ErpLinks");

            migrationBuilder.DropTable(
                name: "FileSessions");

            migrationBuilder.DropTable(
                name: "WorkbookPermissions");

            migrationBuilder.DropTable(
                name: "WorkbookPreviews");

            migrationBuilder.DropTable(
                name: "Workbooks");

            migrationBuilder.DropTable(
                name: "WorkbookTickets");

            migrationBuilder.DropTable(
                name: "WorkbookVersions");
        }
    }
}
