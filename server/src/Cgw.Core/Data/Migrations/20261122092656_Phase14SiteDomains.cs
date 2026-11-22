using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Cgw.Core.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase14SiteDomains : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "AcmeAccounts",
                columns: table => new
                {
                    Directory = table.Column<string>(type: "varchar(500)", unicode: false, maxLength: 500, nullable: false),
                    KeyCipher = table.Column<string>(type: "varchar(4000)", unicode: false, maxLength: 4000, nullable: false),
                    AccountUrl = table.Column<string>(type: "varchar(500)", unicode: false, maxLength: 500, nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AcmeAccounts", x => x.Directory);
                });

            migrationBuilder.CreateTable(
                name: "SiteDomains",
                columns: table => new
                {
                    Id = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    WorkspaceId = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    Host = table.Column<string>(type: "varchar(253)", unicode: false, maxLength: 253, nullable: false),
                    Token = table.Column<string>(type: "varchar(32)", unicode: false, maxLength: 32, nullable: false),
                    CreatedBy = table.Column<byte[]>(type: "binary(16)", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: false),
                    VerifiedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    VerifiedBy = table.Column<byte[]>(type: "binary(16)", nullable: true),
                    SiteId = table.Column<byte[]>(type: "binary(16)", nullable: true),
                    AttachedBy = table.Column<byte[]>(type: "binary(16)", nullable: true),
                    AttachedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    ProofCheckedAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    ProofMissingSince = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    Certificate = table.Column<string>(type: "varchar(20)", unicode: false, maxLength: 20, nullable: false),
                    CertificateExpiresAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    CertificateRenewAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    CertificateNextAttemptAt = table.Column<DateTimeOffset>(type: "datetimeoffset(3)", nullable: true),
                    CertificateAttempts = table.Column<int>(type: "int", nullable: false),
                    CertificateError = table.Column<string>(type: "varchar(40)", unicode: false, maxLength: 40, nullable: true),
                    CertificateThumbprint = table.Column<string>(type: "varchar(64)", unicode: false, maxLength: 64, nullable: true),
                    ChallengeToken = table.Column<string>(type: "varchar(128)", unicode: false, maxLength: 128, nullable: true),
                    ChallengeAnswer = table.Column<string>(type: "varchar(256)", unicode: false, maxLength: 256, nullable: true),
                    Version = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SiteDomains", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_SiteDomains_Site",
                table: "SiteDomains",
                column: "SiteId",
                unique: true,
                filter: "[SiteId] IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_SiteDomains_Verified",
                table: "SiteDomains",
                column: "Host",
                unique: true,
                filter: "[VerifiedAt] IS NOT NULL")
                .Annotation("SqlServer:Include", new[] { "WorkspaceId", "SiteId", "Certificate" });

            migrationBuilder.CreateIndex(
                name: "IX_SiteDomains_Workspace",
                table: "SiteDomains",
                columns: new[] { "WorkspaceId", "Host" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AcmeAccounts");

            migrationBuilder.DropTable(
                name: "SiteDomains");
        }
    }
}
