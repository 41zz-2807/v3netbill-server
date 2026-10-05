import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    // ⚠️ Assertion ini sudah basi sejak template awal Nest dan tidak pernah
    // ikut diperbarui, jadi `npm test` gagal terus selama berbulan-bulan dan
    // membuat suite terlihat merah — dan menggeser perhatian dari test yang
    // benar-benar lulus.
    it('mengembalikan pesan banner backend, bukan string template', () => {
      expect(appController.getHello()).toBe('v3Netbill Backend is running!');
    });
  });

  describe('health', () => {
    it('status ok', () => {
      expect(appController.healthCheck().status).toBe('ok');
    });

    it('timestamp berformat ISO', () => {
      const { timestamp } = appController.healthCheck();
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });
});
