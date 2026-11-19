using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Cgw.Core.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase11Sso : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "EndsAt",
                table: "Devices",
                type: "datetimeoffset(3)",
                nullable: true);

            migrationBuilder.AddColumn<byte[]>(
                name: "SsoWorkspaceId",
                table: "Devices",
                type: "binary(16)",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "SsoDomains",
                columns: table => new
                {
                    Id = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Domain = table.Column<string>(type: "varchar(253)", unicode: false, maxLength: 253, nullable: false),
                    Token = table.Column<string>(type: "varchar(32)", unicode: false, maxLength: 32, nullable: false),
                    CreatedBy = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    VerifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    VerifiedBy = table.Column<byte[]>(type: "binary(16)", nullable: true),
                    Required = table.Column<bool>(type: "bit", nullable: false),
                    RequiredAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    RequiredBy = table.Column<byte[]>(type: "binary(16)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SsoDomains", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "SsoProviders",
                columns: table => new
                {
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Issuer = table.Column<string>(type: "varchar(500)", unicode: false, maxLength: 500, nullable: false),
                    ClientId = table.Column<string>(type: "varchar(256)", unicode: false, maxLength: 256, nullable: false),
                    SecretCipher = table.Column<string>(type: "varchar(4000)", unicode: false, maxLength: 4000, nullable: true),
                    JoinAsMember = table.Column<bool>(type: "bit", nullable: false),
                    SessionHours = table.Column<int>(type: "int", nullable: false),
                    TestedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    TestedBy = table.Column<byte[]>(type: "binary(16)", nullable: true),
                    Version = table.Column<long>(type: "bigint", nullable: false),
                    CreatedBy = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    UpdatedBy = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SsoProviders", x => x.WorkspaceId);
                });

            migrationBuilder.CreateIndex(
                name: "IX_SsoDomains_Verified",
                table: "SsoDomains",
                column: "Domain",
                unique: true,
                filter: "[VerifiedAt] IS NOT NULL")
                .Annotation("SqlServer:Include", new[] { "WorkspaceId", "Required" });

            migrationBuilder.CreateIndex(
                name: "IX_SsoDomains_Workspace",
                table: "SsoDomains",
                columns: new[] { "WorkspaceId", "Domain" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "SsoDomains");

            migrationBuilder.DropTable(
                name: "SsoProviders");

            migrationBuilder.DropColumn(
                name: "EndsAt",
                table: "Devices");

            migrationBuilder.DropColumn(
                name: "SsoWorkspaceId",
                table: "Devices");
        }
    }
}
